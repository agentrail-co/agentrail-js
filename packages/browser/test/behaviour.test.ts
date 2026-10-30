import { linkMarker, newMarker } from 'agentrail-core';
import { afterEach, describe, expect, it } from 'vitest';

import { KEY_CLASSES, type BrowserCall, type Frame } from '../src/index.js';
import { onPage } from './support/page.js';

/** Every frame the collector got, in order. */
async function framesOf(site: ReturnType<typeof onPage>): Promise<Frame[]> {
  return (await site.sent()).flatMap((call) =>
    call.behaviour.flatMap((batch) => [...batch.frames]),
  );
}

const key = (type: 'keydown' | 'keyup', name: string, repeat = false) =>
  new KeyboardEvent(type, { key: name, repeat, bubbles: true });

describe('the behaviour recorder', () => {
  // Fails if someone sends a key, a typed value, a pasted text or a chosen
  // option (none may leave the page), or numbers a key's down and up apart
  // (hold times could not be read), or loses Backspace's class (typing
  // corrections could not be counted).
  it("keeps a key's press and class, never the key, and that a paste, an input and a change happened, never what", async () => {
    const site = onPage({ fingerprint: false });
    await site.agentrail.ready;
    const field = document.body.appendChild(document.createElement('input'));
    field.value = 'hunter2';
    for (const event of [
      key('keydown', 'h'),
      key('keydown', 'h', true),
      key('keyup', 'h'),
      key('keydown', 'Backspace'),
      key('keyup', 'Backspace'),
      key('keyup', 'q'),
    ])
      field.dispatchEvent(event);
    const paste = new Event('paste', { bubbles: true });
    field.dispatchEvent(paste);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    const frames = await framesOf(site);
    const body = JSON.stringify(await site.calls());

    const keys = frames.filter(
      (frame) => frame[0] === 'kd' || frame[0] === 'ku',
    );
    expect(keys.map((frame) => frame.slice(0, 6))).toEqual([
      ['kd', 1, 1, 0, KEY_CLASSES.other, 1],
      ['kd', 1, 1, 1, KEY_CLASSES.other, 1],
      ['ku', 1, 1, 0, KEY_CLASSES.other, 1],
      ['kd', 1, 2, 0, KEY_CLASSES.editing, 1],
      ['ku', 1, 2, 0, KEY_CLASSES.editing, 1],
      // A key let go that this page never saw go down: a press of its own.
      ['ku', 1, 3, 0, KEY_CLASSES.other, 1],
    ]);
    expect(
      frames
        .filter((frame) => ['p', 'i', 'c'].includes(frame[0]))
        .map((frame) => frame.slice(0, 2)),
    ).toEqual([
      ['p', 1],
      ['i', 1],
      ['c', 1],
    ]);
    expect(body).not.toContain('hunter2');
    expect(body).not.toMatch(/"(?:h|q|Backspace)"/u);
  });

  // Fails if someone drops what the browser coalesced into a move, or
  // calls a move with no pointer event before it a real one: a page driven
  // by an automation protocol would look moved by hand.
  it('keeps every mouse move with what the browser coalesced into it, and a dispatched move as none', async () => {
    const site = onPage({ fingerprint: false });
    await site.agentrail.ready;
    const moved = new PointerEvent('pointermove', {
      pointerType: 'mouse',
      bubbles: true,
    });
    Object.defineProperty(moved, 'getCoalescedEvents', {
      value: () => [moved, moved, moved],
    });
    window.dispatchEvent(moved);
    window.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 10, clientY: 20, bubbles: true }),
    );
    window.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 11, clientY: 22, bubbles: true }),
    );
    const moves = (await framesOf(site)).filter((frame) => frame[0] === 'mm');

    expect(moves.map((frame) => frame.slice(0, 5))).toEqual([
      ['mm', 0, 10, 20, 3],
      ['mm', 0, 11, 22, 0],
    ]);
  });

  // Fails if someone records scrolls as one target (FP-Agent reads each
  // element's scrolls apart), or names an element by anything of the DOM.
  it('numbers each scrolled element by its first use, and the document as 0', async () => {
    const site = onPage({ fingerprint: false });
    await site.agentrail.ready;
    const pane = document.body.appendChild(document.createElement('div'));
    pane.id = 'customer-private-pane';
    document.dispatchEvent(new Event('scroll'));
    pane.dispatchEvent(new Event('scroll'));
    pane.dispatchEvent(new Event('scrollend'));
    const scrolls = (await framesOf(site)).filter(
      (frame) => frame[0] === 'sc' || frame[0] === 'se',
    );

    expect(scrolls.map((frame) => frame.slice(0, 2))).toEqual([
      ['sc', 0],
      ['sc', 1],
      ['se', 1],
    ]);
    expect(JSON.stringify(await site.calls())).not.toContain(
      'customer-private-pane',
    );
  });

  // Fails if someone drops the trust flag from a frame: a paste, an input or
  // a scroll a script dispatched would read as a person's.
  it("marks every frame a script dispatched as no person's", async () => {
    const site = onPage({ fingerprint: false });
    await site.agentrail.ready;
    const field = document.body.appendChild(document.createElement('input'));
    for (const type of ['paste', 'input', 'change'])
      field.dispatchEvent(new Event(type, { bubbles: true }));
    document.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new Event('scrollend'));
    field.dispatchEvent(
      new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }),
    );
    window.dispatchEvent(new FocusEvent('focus'));
    window.dispatchEvent(new FocusEvent('blur'));
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    const frames = await framesOf(site);

    expect(frames.map((frame) => [frame[0], frame.at(-2)])).toEqual([
      ['p', 1],
      ['i', 1],
      ['c', 1],
      ['sc', 1],
      ['se', 1],
      ['pd', 1],
      ['fo', 1],
      ['bl', 1],
      ['vs', 1],
    ]);
  });

  // Fails if someone records the page being hidden after the script's beacon
  // has gone: a background tab the browser ends without a pagehide would
  // lose its last frame.
  it('sends the frame of the page being hidden in its beacon', async () => {
    const site = onPage({ fingerprint: false });
    await site.agentrail.ready;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    try {
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
    const beaconed = await Promise.all(
      site.beacons.map(
        async (beacon) => JSON.parse(await beacon.text()) as BrowserCall,
      ),
    );

    expect(
      beaconed.flatMap((call) =>
        call.behaviour.flatMap((batch) => batch.frames),
      ),
    ).toEqual([['vs', 0, 1, expect.any(Number)]]);
  });

  // Fails if someone files frames under the page view they were sent with
  // rather than the one they happened on: a route change would hand the
  // last page's behaviour to the next.
  it('files each batch under the page view its frames happened on', async () => {
    const site = onPage({ fingerprint: false });
    await site.agentrail.ready;
    window.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, bubbles: true }),
    );
    window.history.pushState(null, '', '/next');
    window.dispatchEvent(
      new MouseEvent('mouseup', { button: 0, bubbles: true }),
    );
    const calls = await site.sent();
    const views = calls.flatMap((call) => call.events);
    const batches = calls.flatMap((call) => call.behaviour);

    expect(
      batches.map((batch) => [
        batch.page,
        batch.frames.map((frame) => frame[0]),
      ]),
    ).toEqual([
      [views[0]?.id, ['md']],
      [views[1]?.id, ['mu']],
    ]);
  });
});

describe("the page's WebMCP tools", () => {
  const holder = window.navigator as Navigator & { modelContext?: unknown };
  afterEach(() => {
    Reflect.deleteProperty(holder, 'modelContext');
  });

  // Fails if someone stops wrapping the tools a page gives (an agent acting
  // inside the session would leave no step), keeps a tool's arguments
  // (a field value would leave the page), loses the markers in them, or
  // records only the calls that succeed.
  it('records each tool call an agent makes, with the markers in its arguments and nothing else of them, whether it answers or throws', async () => {
    const registered: { execute: (input: unknown) => Promise<unknown> }[] = [];
    Object.defineProperty(holder, 'modelContext', {
      configurable: true,
      value: {
        registerTool(tool: { execute: (input: unknown) => Promise<unknown> }) {
          registered.push(tool);
        },
      },
    });
    const site = onPage({ behaviour: false, fingerprint: false });
    const context = holder.modelContext as {
      registerTool: (tool: object) => void;
    };
    context.registerTool({
      name: 'book',
      execute: () => Promise.resolve('booked'),
    });
    context.registerTool({
      name: 'pay',
      execute: () => Promise.reject(new Error('declined')),
    });
    const marker = linkMarker(newMarker(), 4);

    await expect(
      registered[0]?.execute({
        email: 'person@example.test',
        from: `https://docs.example.test/start?h=${marker}`,
      }),
    ).resolves.toBe('booked');
    await expect(registered[1]?.execute({ card: '4242' })).rejects.toThrow(
      'declined',
    );
    const events = (await site.sent()).flatMap((call) => call.events);
    const [view, ...tools] = events;

    expect(
      tools.map((tool) => [
        tool.kind,
        tool.markers.seen,
        tool.span?.parentSpanId,
      ]),
    ).toEqual([
      ['agent.tool.executed', [marker], view?.span?.spanId],
      ['agent.tool.executed', [], view?.span?.spanId],
    ]);
    const body = JSON.stringify(await site.calls());
    expect(body).not.toContain('person@example.test');
    expect(body).not.toContain('4242');
  });

  // Fails if someone reads the page or the markers once the tool has run: a
  // tool that moves the page on would be filed under the next page, and one
  // that takes the link it consumed out of its input would lose the marker.
  it('records the page and the markers a tool was called with, whatever the tool changes', async () => {
    const registered: { execute: (input: unknown) => Promise<unknown> }[] = [];
    Object.defineProperty(holder, 'modelContext', {
      configurable: true,
      value: {
        provideContext(context: {
          tools: { execute: (input: unknown) => Promise<unknown> }[];
        }) {
          registered.push(...context.tools);
        },
      },
    });
    const site = onPage({ behaviour: false, fingerprint: false });
    const context = holder.modelContext as {
      provideContext: (context: { tools: object[] }) => void;
    };
    context.provideContext({
      tools: [
        {
          name: 'open',
          execute: (input: { from?: string }) => {
            delete input.from;
            window.history.pushState(null, '', '/opened');
            return Promise.resolve('opened');
          },
        },
      ],
    });
    const marker = linkMarker(newMarker(), 4);
    await registered[0]?.execute({
      from: `https://docs.example.test/start?h=${marker}`,
    });
    const events = (await site.sent()).flatMap((call) => call.events);
    const [view, , tool] = events;

    expect(tool).toMatchObject({
      kind: 'agent.tool.executed',
      markers: { seen: [marker] },
      span: { traceId: view?.span?.traceId, parentSpanId: view?.span?.spanId },
    });
  });
});
