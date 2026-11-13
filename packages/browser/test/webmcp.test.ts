import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BrowserCollectorRefusedError,
  BrowserCollectorUnavailableError,
  BrowserPayloadBudgetError,
  BrowserPayloadRedactError,
  type BrowserOptions,
  type BrowserPayloadCall,
} from '../src/index.js';
import { fitted } from '../src/payloads.js';
import { COLLECTOR, onPage, PAYLOADS } from './support/page.js';

const holder = window.navigator as Navigator & { modelContext?: unknown };
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** The browser's WebMCP, stood in before the script starts; the tools the page gave, wrapped. */
function webmcp() {
  const registered = new Map<string, (input?: unknown) => Promise<unknown>>();
  Object.defineProperty(holder, 'modelContext', {
    configurable: true,
    value: {
      registerTool(tool: {
        name: string;
        execute: (input?: unknown) => Promise<unknown>;
      }) {
        registered.set(tool.name, tool.execute);
      },
    },
  });
  return {
    give(name: string, execute: (input?: unknown) => unknown) {
      (
        holder.modelContext as { registerTool: (tool: object) => void }
      ).registerTool({ name, execute });
    },
    run(name: string, input?: unknown) {
      const execute = registered.get(name);
      if (execute === undefined) throw new Error(`No tool ${name}.`);
      return execute(input);
    },
  };
}
const quiet: Partial<BrowserOptions> = { behaviour: false, fingerprint: false };
const settled = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('WebMCP tool runs', () => {
  afterEach(() => {
    Reflect.deleteProperty(holder, 'modelContext');
  });

  // Fails if someone stops recording which tool ran, records a thrown tool
  // or one whose result said it failed as answered, keeps a name the
  // collector would refuse, or sends a payload a site never turned on.
  it('records which tool ran, how it ended and the size of what went in and out, never the content', async () => {
    const tools = webmcp();
    const site = onPage(quiet);
    const booked = { booked: 'SYNTHETIC_PRIVATE_RESULT' };
    tools.give('book', () => Promise.resolve(booked));
    tools.give('pay', () => Promise.reject(new Error('declined')));
    tools.give('check', () =>
      Promise.resolve({
        isError: true,
        content: [{ type: 'text', text: 'no' }],
      }),
    );
    tools.give('not a name!', () => Promise.resolve('done'));

    const asked = { email: 'person@example.test' };
    await tools.run('book', asked);
    await expect(tools.run('pay', { card: '4242' })).rejects.toThrow(
      'declined',
    );
    await tools.run('check', {});
    await tools.run('not a name!');
    const runs = (await site.sent())
      .flatMap((call) => call.events)
      .filter((event) => event.kind === 'agent.tool.executed');

    expect(runs.map((event) => event.webmcp)).toEqual([
      {
        tool: 'book',
        outcome: 'answered',
        argumentBytes: bytes(asked),
        resultBytes: bytes(booked),
      },
      {
        tool: 'pay',
        outcome: 'threw',
        argumentBytes: bytes({ card: '4242' }),
        resultBytes: null,
      },
      {
        tool: 'check',
        outcome: 'is_error',
        argumentBytes: 2,
        resultBytes: bytes({
          isError: true,
          content: [{ type: 'text', text: 'no' }],
        }),
      },
      { tool: null, outcome: 'answered', argumentBytes: null, resultBytes: 6 },
    ]);
    expect(site.fetched.filter((call) => call.url === PAYLOADS)).toEqual([]);
    const body = JSON.stringify(await site.calls());
    expect(body).not.toContain('person@example.test');
    expect(body).not.toContain('SYNTHETIC_PRIVATE');
  });

  // Fails if someone sends the content unredacted, in a body the collector
  // refuses, by keepalive (an open page's large payload would take a closing
  // page's budget), or sends the run twice.
  it('sends a run with its redacted content to the payloads route, and the run only there', async () => {
    const tools = webmcp();
    const site = onPage({
      ...quiet,
      capturePayloads: {
        redact: (run) => ({
          arguments: { ...(run.arguments as object), email: '[redacted]' },
          result: run.result,
        }),
      },
    });
    tools.give('book', () => Promise.resolve({ booked: true }));
    await tools.run('book', { email: 'person@example.test', from: 'docs' });
    await settled();
    const [payload, ...more] = await site.payloadCalls();

    expect(more).toEqual([]);
    expect(payload?.call.payload).toEqual({
      request: '{"email":"[redacted]","from":"docs"}',
      response: '{"booked":true}',
      requestTruncated: false,
      responseTruncated: false,
    });
    expect(payload?.call.event.webmcp?.tool).toBe('book');
    expect(site.fetched.find((call) => call.url === PAYLOADS)?.keepalive).toBe(
      false,
    );
    const events = (await site.sent()).flatMap((call) => call.events);
    expect(events.map((event) => event.id)).not.toContain(
      payload?.call.event.id,
    );
    expect(
      JSON.stringify([...site.fetched.map((call) => call.body)]),
    ).not.toContain('person@example.test');
  });

  // Fails if someone sends a payload the redact hook withheld, lets a
  // throwing hook break the tool's caller, or loses the run when its
  // payload call fails.
  it.each([
    ['withheld', () => null, () => new Response('{}', { status: 200 })],
    [
      'throwing',
      () => {
        throw new Error('Synthetic redact failure.');
      },
      () => new Response('{}', { status: 200 }),
    ],
    [
      'unserialisable',
      () => ({ arguments: 1n, result: null }),
      () => new Response('{}', { status: 200 }),
    ],
    [
      'refused',
      (run: { arguments: unknown; result: unknown }) => run,
      () => new Response('{}', { status: 500 }),
    ],
  ] as const)(
    'still sends the run as an event when its payload does not go (%s)',
    async (variant, redact, answer) => {
      const tools = webmcp();
      const errors: Error[] = [];
      const site = onPage(
        {
          ...quiet,
          capturePayloads: { redact },
          onError: (error) => errors.push(error),
        },
        (url) =>
          url === PAYLOADS ? answer() : new Response('{}', { status: 200 }),
      );
      tools.give('book', () => Promise.resolve({ booked: true }));
      await expect(tools.run('book', { email: 'a' })).resolves.toEqual({
        booked: true,
      });
      await settled();
      const runs = (await site.sent())
        .flatMap((call) => call.events)
        .filter((event) => event.kind === 'agent.tool.executed');

      expect(runs.map((event) => event.webmcp?.tool)).toEqual(['book']);
      expect(errors).toEqual(
        variant === 'withheld'
          ? []
          : [
              variant === 'throwing' || variant === 'unserialisable'
                ? expect.any(BrowserPayloadRedactError)
                : new BrowserCollectorRefusedError(500),
            ],
      );
      expect((await site.payloadCalls()).length).toBe(
        variant === 'refused' ? 1 : 0,
      );
    },
  );

  // Fails if someone lets a closing page's payload go by the open page's
  // fetch alone (the browser cancels it), or sends it past the budget a
  // closing page's calls share, or cuts it through a character.
  it('sends a payload still on its way as a beacon when the page goes, within 30,000 bytes', async () => {
    const tools = webmcp();
    const site = onPage(
      { ...quiet, capturePayloads: { redact: (run) => run } },
      // The payload call never gets its answer before the page goes.
      (url) =>
        url === PAYLOADS
          ? new Promise<Response>(() => undefined)
          : new Response('{}', { status: 200 }),
    );
    const large = { text: `a${'\u{1F600}"'.repeat(20_000)}` };
    tools.give('read', () => Promise.resolve(large));
    await tools.run('read', { page: 1 });
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    // The open page's fetch first, then the closing page's beacon.
    const closing = (await site.payloadCalls()).at(-1);

    expect(
      site.beacons.filter((beacon) => beacon.url === PAYLOADS),
    ).toHaveLength(1);
    expect(closing?.bytes).toBeLessThanOrEqual(30_000);
    expect(closing?.call.payload).toMatchObject({
      request: '{"page":1}',
      requestTruncated: false,
      responseTruncated: true,
    });
    const response = closing?.call.payload.response ?? '';
    expect(response.isWellFormed()).toBe(true);
    expect(JSON.stringify(large).startsWith(response)).toBe(true);
    expect(response.length).toBeGreaterThan(1_000);
    // The run went once, with its payload: not again on the event route.
    const events = (await site.calls()).flatMap((call) => call.events);
    expect(events.map((event) => event.kind)).toEqual(['page.view']);
    expect(site.fetched.some((call) => call.url === COLLECTOR)).toBe(false);
  });
});

describe('WebMCP runs, as a good guest of the page', () => {
  afterEach(() => {
    Reflect.deleteProperty(holder, 'modelContext');
    Reflect.deleteProperty(document, 'visibilityState');
  });
  const never = (url: string) =>
    url === PAYLOADS
      ? new Promise<Response>(() => undefined)
      : new Response('{}', { status: 200 });

  // Fails if someone lets sizing a run throw into the tool's caller: a
  // page's own throwing toJSON would replace the tool's answer.
  it('never lets sizing a run fail the tool', async () => {
    const tools = webmcp();
    const site = onPage(quiet);
    const awkward = {
      toJSON() {
        throw new Error('Synthetic toJSON failure.');
      },
    };
    tools.give('awkward', () => Promise.resolve(awkward));
    await expect(tools.run('awkward', awkward)).resolves.toBe(awkward);
    const [run] = (await site.sent())
      .flatMap((call) => call.events)
      .filter((event) => event.kind === 'agent.tool.executed');
    expect(run?.webmcp).toEqual({
      tool: 'awkward',
      outcome: 'answered',
      argumentBytes: null,
      resultBytes: null,
    });
  });

  // Fails if someone takes JSON.stringify to always give text: a toJSON
  // that gives undefined would be sized as 0, or, with payloads captured,
  // replace the tool's answer.
  it.each([
    ['off', undefined],
    ['on', { redact: (run: { arguments: unknown; result: unknown }) => run }],
  ] as const)(
    'gives null sizes for a value with no JSON, payloads %s',
    async (_, capturePayloads) => {
      const tools = webmcp();
      const errors: Error[] = [];
      const site = onPage(
        {
          ...quiet,
          onError: (error) => errors.push(error),
          ...(capturePayloads === undefined ? {} : { capturePayloads }),
        },
        never,
      );
      const empty = { toJSON: () => undefined };
      tools.give('empty', () => Promise.resolve(empty));
      await expect(tools.run('empty', empty)).resolves.toBe(empty);
      await settled();
      const run =
        (await site.payloadCalls()).at(-1)?.call.event ??
        (await site.sent())
          .flatMap((call) => call.events)
          .find((event) => event.kind === 'agent.tool.executed');
      expect(run?.webmcp).toMatchObject({
        argumentBytes: null,
        resultBytes: null,
      });
      expect(errors).toEqual([]);
    },
  );

  // Fails if someone hands the redact hook the live result: a hook that
  // redacts in place would change what the tool's caller gets.
  it('gives the redact hook copies, so redacting in place never changes the answer', async () => {
    const tools = webmcp();
    onPage({
      ...quiet,
      capturePayloads: {
        redact: (run) => {
          (run.result as { booked: unknown }).booked = 'changed';
          return null;
        },
      },
    });
    tools.give('book', () => Promise.resolve({ booked: true }));
    await expect(tools.run('book', {})).resolves.toEqual({ booked: true });
  });

  // Fails if someone resends a hidden tab's payloads (its fetches go on, so
  // the run would arrive twice), or beacons more than one payload as the
  // page closes (the beacons share a budget with the queue's last call).
  it('resends no payload when the tab is only hidden, and one as the page closes', async () => {
    const tools = webmcp();
    const site = onPage(
      { ...quiet, capturePayloads: { redact: (run) => run } },
      never,
    );
    tools.give('read', () => Promise.resolve({ text: 'x'.repeat(20_000) }));
    await tools.run('read', { page: 1 });
    await tools.run('read', { page: 2 });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    const toPayloads = () =>
      site.beacons.filter((beacon) => beacon.url === PAYLOADS);
    expect(toPayloads()).toEqual([]);

    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    expect(toPayloads()).toHaveLength(1);
    const runs = (await site.calls())
      .flatMap((call) => call.events)
      .filter((event) => event.kind === 'agent.tool.executed');
    const beaconed = (await site.payloadCalls()).at(-1)?.call.event.id;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).not.toBe(beaconed);
  });
});

describe('payloads on their way', () => {
  afterEach(() => {
    Reflect.deleteProperty(holder, 'modelContext');
    vi.useRealTimers();
  });
  const never = (url: string) =>
    url === PAYLOADS
      ? new Promise<Response>(() => undefined)
      : new Response('{}', { status: 200 });
  const runsOf = async (site: ReturnType<typeof onPage>) =>
    (await site.sent())
      .flatMap((call) => call.events)
      .filter((event) => event.kind === 'agent.tool.executed');

  // Fails if someone gives a payload call no deadline: a collector that
  // never answers would hold the run, and its content, for good.
  it('sends a run alone once its payload call has taken 25 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const tools = webmcp();
    const errors: Error[] = [];
    const site = onPage(
      {
        ...quiet,
        capturePayloads: { redact: (run) => run },
        onError: (error) => errors.push(error),
      },
      never,
    );
    tools.give('book', () => Promise.resolve({ booked: true }));
    await tools.run('book', {});
    vi.advanceTimersByTime(24_999);
    expect(await runsOf(site)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect((await runsOf(site)).map((event) => event.webmcp?.tool)).toEqual([
      'book',
    ]);
    expect(errors).toEqual([expect.any(BrowserCollectorUnavailableError)]);
  });

  // Fails if someone lets payloads on their way pile up without bound: a
  // collector slow to answer would hold every run's content in the page.
  it('holds at most 64 MiB of payloads on their way, and sends a run past it alone', async () => {
    const tools = webmcp();
    const errors: Error[] = [];
    const site = onPage(
      {
        ...quiet,
        capturePayloads: { redact: (run) => run },
        onError: (error) => errors.push(error),
      },
      never,
    );
    const large = 'x'.repeat(13 * 1024 * 1024);
    tools.give('read', () => Promise.resolve(large));
    for (let index = 0; index < 5; index += 1) await tools.run('read', {});
    expect(site.fetched.filter((call) => call.url === PAYLOADS)).toHaveLength(
      4,
    );
    expect(await runsOf(site)).toHaveLength(1);
    expect(errors).toEqual([expect.any(BrowserPayloadBudgetError)]);
  }, 60_000);

  // Fails if someone stops the queue with a run's payload still on its way:
  // a payload call that then failed would leave the run with nowhere to go.
  it('sends each run whose payload is on its way alone when it stops', async () => {
    const tools = webmcp();
    const site = onPage(
      { ...quiet, capturePayloads: { redact: (run) => run } },
      never,
    );
    tools.give('book', () => Promise.resolve({ booked: true }));
    await tools.run('book', {});
    site.agentrail.stop();
    const runs = (await site.calls())
      .flatMap((call) => call.events)
      .filter((event) => event.kind === 'agent.tool.executed');
    expect(runs.map((event) => event.webmcp?.tool)).toEqual(['book']);
  });
});

describe('a payload cut to fit', () => {
  // Fails if someone cuts a payload through a surrogate pair (the collector
  // refuses half a pair) or past the budget, at any of a character's offsets.
  it('stays well-formed and within the budget wherever the cut falls', () => {
    const response = JSON.stringify({ text: '\u{1F600}'.repeat(5_000) });
    const call = {
      key: 'ajp_public-key-of-the-browser-source',
      component: { name: 'agentrail-browser', version: '0', surfaces: [] },
      tab: 'tab',
      event: {} as BrowserPayloadCall['event'],
      payload: {
        request: null,
        response,
        requestTruncated: false,
        responseTruncated: false,
      },
    };
    for (let budget = 10_000; budget < 10_008; budget += 1) {
      const cut = fitted(call, budget);
      expect(bytes(cut)).toBeLessThanOrEqual(budget);
      expect(cut.payload.response?.isWellFormed()).toBe(true);
      expect(response.startsWith(cut.payload.response ?? '-')).toBe(true);
      expect(cut.payload).toMatchObject({
        request: null,
        requestTruncated: false,
        responseTruncated: true,
      });
    }
  });
});
