import {
  newSpanId,
  type AgentrailEvent,
  type SpanContext,
  type WebMcpOutcome,
} from 'agentrail-core';

import { browserEvent, markersInText, type Recorder } from './events.js';
import { BROWSER_EVENT_KINDS, type Page } from './wire.js';

/**
 * WebMCP: the page's tools for an agent driving it (`registerTool` and
 * `provideContext` on `navigator.modelContext`, or `document.modelContext`
 * where a browser puts it). Every tool the page gives is wrapped, so each
 * call an agent makes through it is recorded: proof that an agent acted
 * inside this session, and when, which tool, how it ended and the size of
 * what went in and out. The tool's arguments are read for markers and
 * their size, and never kept (an unkeyed hash of them would be
 * reversible), unless the site turns payload capture on: then the run goes
 * to the site's redact hook first.
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

/** A tool run's content, for a site that captures payloads. */
export interface ToolRun {
  readonly tool: string | null;
  /** The arguments as the tool was given them, before it ran. */
  readonly arguments: unknown;
  /** Undefined where the tool threw. */
  readonly result: unknown;
}

export interface ToolContext {
  readonly recorder: Recorder;
  readonly page: () => SpanContext;
  readonly now: () => number;
  readonly record: (event: AgentrailEvent) => void;
  /** Takes a run with its content in place of `record`, where payloads are captured. */
  readonly ran?: (event: AgentrailEvent, run: ToolRun) => void;
}

/** A tool name the collector keeps; any other is recorded as null. */
const TOOL_NAME = /^[A-Za-z0-9_./-]{1,128}$/u;
const encoder = new TextEncoder();

/** A value's JSON text; null where it has none (undefined, a function, a cycle, a BigInt). */
export function jsonOf(value: unknown): string | null {
  // JSON.stringify gives no text for these.
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  )
    return null;
  try {
    return JSON.stringify(value);
  } catch {
    // A cycle or a BigInt, or the page's own getter or toJSON throwing:
    // whatever it is, the tool's caller never gets it, and the size is null.
    return null;
  }
}
const bytesOf = (text: string | null) =>
  text === null ? null : encoder.encode(text).byteLength;
const saidItFailed = (result: unknown) =>
  typeof result === 'object' &&
  result !== null &&
  Reflect.get(result, 'isError') === true;

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
      const given = jsonOf(args[0]);
      const seen = given === null ? [] : markersInText(given);
      const name = TOOL_NAME.test(tool.name) ? tool.name : null;
      let outcome: WebMcpOutcome = 'threw';
      let result: unknown;
      const record = () => {
        const answered = outcome === 'threw' ? null : jsonOf(result);
        const event = browserEvent(context.recorder, {
          kind: BROWSER_EVENT_KINDS.toolExecuted,
          start,
          // The page's clock follows the device's, which can be set back.
          end: Math.max(start, context.now()),
          span: { traceId: page.traceId, spanId: newSpanId() },
          parentSpanId: page.spanId,
          spanKind: 'internal',
          url: null,
          method: '',
          status: null,
          seen,
          webmcp: {
            tool: name,
            outcome,
            argumentBytes: bytesOf(given),
            resultBytes: bytesOf(answered),
          },
        });
        if (context.ran === undefined) context.record(event);
        else
          // Copies, so a hook that redacts in place never changes what the
          // tool's caller gets.
          context.ran(event, {
            tool: name,
            arguments: given === null ? undefined : JSON.parse(given),
            result: answered === null ? undefined : JSON.parse(answered),
          });
      };
      try {
        result = await tool.execute(...args);
        outcome = saidItFailed(result) ? 'is_error' : 'answered';
        return result;
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
