import {
  newSpanId,
  type AgentrailEvent,
  type SpanContext,
} from 'agentrail-core';

import { browserEvent, markersIn, type Recorder } from './events.js';
import { BROWSER_EVENT_KINDS, type Page } from './wire.js';

/**
 * WebMCP: the page's tools for an agent driving it (`registerTool` and
 * `provideContext` on `navigator.modelContext`, or `document.modelContext`
 * where a browser puts it). Every tool the page gives is wrapped, so each
 * call an agent makes through it is recorded: proof that an agent acted
 * inside this session, and when. The tool's arguments are read only for
 * markers, and never kept; an unkeyed hash of them would be reversible.
 */

interface Tool {
  readonly name: string;
  readonly execute: (...args: unknown[]) => unknown;
}

interface ModelContext {
  registerTool?: (tool: Tool, ...rest: unknown[]) => unknown;
  provideContext?: (
    context: { tools?: readonly Tool[] },
    ...rest: unknown[]
  ) => unknown;
}

export interface ToolContext {
  readonly recorder: Recorder;
  readonly page: () => SpanContext;
  readonly now: () => number;
  readonly record: (event: AgentrailEvent) => void;
}

function isTool(value: unknown): value is Tool {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'execute' in value &&
    typeof value.execute === 'function'
  );
}

function wrapped(tool: Tool, context: ToolContext): Tool {
  return {
    ...tool,
    execute: async (...args: unknown[]) => {
      // Read before the tool runs: a tool may move the page on, or take what
      // it consumed out of its arguments.
      const start = context.now();
      const page = context.page();
      const seen = markersIn(args[0]);
      const record = () => {
        context.record(
          browserEvent(context.recorder, {
            kind: BROWSER_EVENT_KINDS.toolExecuted,
            start,
            end: context.now(),
            span: { traceId: page.traceId, spanId: newSpanId() },
            parentSpanId: page.spanId,
            spanKind: 'internal',
            url: null,
            method: '',
            status: null,
            seen,
          }),
        );
      };
      try {
        return await tool.execute(...args);
      } finally {
        // Recorded whether it answered or threw: the agent acted either way.
        record();
      }
    },
  };
}

/** The model context a browser offers this page, if any. */
function modelContextOf(window: Page): ModelContext | null {
  for (const holder of [window.navigator, window.document] as const) {
    const context: unknown = Reflect.get(holder, 'modelContext');
    if (typeof context === 'object' && context !== null) return context;
  }
  return null;
}

/** Wraps the page's WebMCP tools as they are given; returns what restores them. */
export function traceTools(window: Page, context: ToolContext): () => void {
  const modelContext = modelContextOf(window);
  if (modelContext === null) return () => undefined;
  const { registerTool, provideContext } = modelContext;
  if (registerTool !== undefined)
    modelContext.registerTool = (tool, ...rest) =>
      registerTool.call(
        modelContext,
        isTool(tool) ? wrapped(tool, context) : tool,
        ...rest,
      );
  if (provideContext !== undefined)
    modelContext.provideContext = (given, ...rest) =>
      provideContext.call(
        modelContext,
        {
          ...given,
          ...(given.tools === undefined
            ? {}
            : {
                tools: given.tools.map((tool) =>
                  isTool(tool) ? wrapped(tool, context) : tool,
                ),
              }),
        },
        ...rest,
      );
  return () => {
    if (registerTool !== undefined) modelContext.registerTool = registerTool;
    if (provideContext !== undefined)
      modelContext.provideContext = provideContext;
  };
}
