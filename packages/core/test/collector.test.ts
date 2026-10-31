import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CollectorRefusedError,
  CollectorUnavailableError,
  createCollector,
  type AgentrailEvent,
} from '../src/index.js';

import { COMPONENT, event } from './support/event.js';

interface Call {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: { component: unknown; events: AgentrailEvent[] };
}

/** A status, with the `Retry-After` it carries. */
interface Answer {
  readonly status: number;
  readonly retryAfter: string;
}

/** When a call sent now must end: as the edge gives one, 25 s on. */
function deadline(): number {
  return Date.now() + 25_000;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** A collector whose fetch answers each call with the next of `answers`. */
function collectorAnswering(answers: (number | Answer | 'network')[]) {
  const calls: Call[] = [];
  const waits: number[] = [];
  const errors: Error[] = [];
  const collector = createCollector({
    endpoint: 'https://collector.example.test',
    secret: 'ajs_secret',
    component: COMPONENT,
    onError: (error) => errors.push(error),
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    fetch: (input, init) => {
      if (!(input instanceof URL) || typeof init?.body !== 'string')
        throw new TypeError('the collector sent no URL or no JSON text');
      const headers = new Headers(init.headers);
      calls.push({
        url: input.href,
        authorization: headers.get('authorization'),
        body: JSON.parse(init.body) as Call['body'],
      });
      const answer = answers.shift() ?? 200;
      if (answer === 'network')
        return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(
        typeof answer === 'number'
          ? new Response('{"accepted":1}', { status: answer })
          : new Response('{"accepted":0}', {
              status: answer.status,
              headers: { 'retry-after': answer.retryAfter },
            }),
      );
    },
  });
  return { collector, calls, waits, errors };
}

describe('sending events to the collector', () => {
  // Fails if someone sends without the source's secret, or anywhere but
  // /ingest/events.
  it('sends an event with the source secret and its component', async () => {
    const { collector, calls, errors } = collectorAnswering([]);
    await collector.send(event('e1'), deadline());

    expect(errors).toEqual([]);
    expect(calls).toEqual([
      {
        url: 'https://collector.example.test/ingest/events',
        authorization: 'Bearer ajs_secret',
        body: { component: COMPONENT, events: [event('e1')] },
      },
    ]);
  });

  // Fails if someone sends a call per event again (under load, a call per
  // request reaches the collector), drops the batch cut (one call past the
  // collector's body limit), or resolves a send before the call carrying its
  // event has ended: the platform would cancel that call with the request.
  it('sends what is sent while a call is out in one next call, and resolves each send once the call carrying it has ended', async () => {
    const calls: string[][] = [];
    const answers: (() => void)[] = [];
    const collector = createCollector({
      endpoint: 'https://collector.example.test',
      secret: 'ajs_secret',
      component: COMPONENT,
      batchSize: 2,
      onError: (error) => {
        throw error;
      },
      fetch: (_input, init) => {
        if (typeof init?.body !== 'string') throw new TypeError('no JSON');
        const body = JSON.parse(init.body) as Call['body'];
        calls.push(body.events.map((sent) => sent.id));
        return new Promise((resolve) => {
          answers.push(() => {
            resolve(new Response('{"accepted":1}'));
          });
        });
      },
    });
    const answerNext = async () => {
      answers.shift()?.();
      // Every continuation the answer starts runs before the next look.
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const ended: string[] = [];
    const sends = ['e0', 'e1', 'e2', 'e3'].map(async (id) => {
      await collector.send(event(id), deadline());
      ended.push(id);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([['e0']]);
    expect(ended).toEqual([]);

    await answerNext();
    expect(ended).toEqual(['e0']);
    expect(calls).toEqual([['e0'], ['e1', 'e2'], ['e3']]);

    await answerNext();
    expect(ended).toEqual(['e0']);

    await answerNext();
    await Promise.all(sends);
    expect(ended.toSorted()).toEqual(['e0', 'e1', 'e2', 'e3']);
    expect(calls).toHaveLength(3);
  });

  // Fails if someone stops retrying a failure the collector or the network
  // had, retries without waiting, or waits the whole backoff every time:
  // components that failed together would all try again together.
  it('tries a call again after the network or the collector failed, with the same events, after a random part of each backoff', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { collector, calls, waits, errors } = collectorAnswering([
      'network',
      503,
    ]);
    await collector.send(event('e1'), deadline());

    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((call) => JSON.stringify(call.body))).size).toBe(
      1,
    );
    expect(waits).toEqual([125, 500]);
    expect(errors).toEqual([]);
  });

  // Fails if someone ignores Retry-After (the collector refuses a call tried
  // sooner again), reads only one of its two forms, or waits it out past the
  // deadline, where the platform cancels the call and no one is told.
  it('waits at least as long as Retry-After asks, and gives up at once when that ends past the deadline', async () => {
    const seconds = collectorAnswering([{ status: 503, retryAfter: '2' }]);
    await seconds.collector.send(event('e1'), deadline());
    expect(seconds.calls).toHaveLength(2);
    expect(seconds.waits).toEqual([2_000]);
    expect(seconds.errors).toEqual([]);

    const date = collectorAnswering([
      {
        status: 503,
        retryAfter: new Date(Date.now() + 5_000).toUTCString(),
      },
    ]);
    await date.collector.send(event('e1'), deadline());
    expect(date.calls).toHaveLength(2);
    expect(date.waits[0]).toBeGreaterThan(3_000);

    const late = collectorAnswering([{ status: 429, retryAfter: '60' }]);
    await late.collector.send(event('e1'), deadline());
    expect(late.calls).toHaveLength(1);
    expect(late.waits).toEqual([]);
    expect(late.errors).toEqual([expect.any(CollectorUnavailableError)]);
  });

  // Fails if someone retries a refusal (a revoked secret is refused forever)
  // or loses the failure without telling anyone.
  it('gives up a refused call at once, and a call that failed every try, telling onError', async () => {
    const refused = collectorAnswering([401]);
    await refused.collector.send(event('e1'), deadline());
    expect(refused.calls).toHaveLength(1);
    expect(refused.errors).toEqual([expect.any(CollectorRefusedError)]);
    expect(refused.errors[0]).toMatchObject({ status: 401 });

    const lost = collectorAnswering([503, 503, 503]);
    await lost.collector.send(event('e1'), deadline());
    expect(lost.calls).toHaveLength(3);
    expect(lost.errors).toEqual([expect.any(CollectorUnavailableError)]);
  });
});
