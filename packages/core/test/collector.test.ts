import { describe, expect, it } from 'vitest';

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

/** A collector whose fetch answers each call with the next of `answers`. */
function collectorAnswering(
  answers: (number | 'network')[],
  batchSize?: number,
) {
  const calls: Call[] = [];
  const waits: number[] = [];
  const errors: Error[] = [];
  const collector = createCollector({
    endpoint: 'https://collector.example.test',
    secret: 'ajs_secret',
    component: COMPONENT,
    ...(batchSize === undefined ? {} : { batchSize }),
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
        new Response('{"accepted":1}', { status: answer }),
      );
    },
  });
  return { collector, calls, waits, errors };
}

describe('sending events to the collector', () => {
  // Fails if someone drops the batch cut (one call past the collector's
  // body limit) or sends without the source's secret.
  it('sends what is queued in batches, with the source secret and its component', async () => {
    const { collector, calls, errors } = collectorAnswering([], 2);
    for (const id of ['e1', 'e2', 'e3']) collector.enqueue(event(id));
    await collector.flush();

    expect(errors).toEqual([]);
    expect(
      calls.map((call) => call.body.events.map((sent) => sent.id)),
    ).toEqual([['e1', 'e2'], ['e3']]);
    expect(calls[0]).toMatchObject({
      url: 'https://collector.example.test/ingest/events',
      authorization: 'Bearer ajs_secret',
      body: { component: COMPONENT },
    });
    // A flush takes what it sends: the next has nothing left to send.
    await collector.flush();
    expect(calls).toHaveLength(2);
  });

  // Fails if someone stops retrying a failure the collector or the network
  // had, or retries without waiting.
  it('tries a call again after the network or the collector failed, with the same events', async () => {
    const { collector, calls, waits, errors } = collectorAnswering([
      'network',
      503,
    ]);
    collector.enqueue(event('e1'));
    await collector.flush();

    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((call) => JSON.stringify(call.body))).size).toBe(
      1,
    );
    expect(waits).toEqual([250, 1_000]);
    expect(errors).toEqual([]);
  });

  // Fails if someone retries a refusal (a revoked secret is refused forever)
  // or loses the failure without telling anyone.
  it('gives up a refused call at once, and a call that failed every try, telling onError', async () => {
    const refused = collectorAnswering([401]);
    refused.collector.enqueue(event('e1'));
    await refused.collector.flush();
    expect(refused.calls).toHaveLength(1);
    expect(refused.errors).toEqual([expect.any(CollectorRefusedError)]);
    expect(refused.errors[0]).toMatchObject({ status: 401 });

    const lost = collectorAnswering([503, 503, 503]);
    lost.collector.enqueue(event('e1'));
    await lost.collector.flush();
    expect(lost.calls).toHaveLength(3);
    expect(lost.errors).toEqual([expect.any(CollectorUnavailableError)]);
  });
});
