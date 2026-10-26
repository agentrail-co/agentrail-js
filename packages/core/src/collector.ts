import type { AgentrailEvent, Component } from './event.js';

/**
 * Sends a component's events to the collector, `POST <endpoint>/ingest/events`
 * with the source's secret: queued as they happen, sent in batches when the
 * component flushes, which an edge does once per request through its
 * platform's `waitUntil`, off the request's path.
 *
 * A call that fails because the network or the collector did (no answer, a
 * 5xx, a 429, or no answer within the try's deadline) is tried again, after
 * 250 ms and then 1 s; each try sends the same events, which the collector
 * counts as duplicates once stored. A call
 * the collector refuses (any other 4xx: a revoked secret, an event it cannot
 * read) is not tried again. Either way the events are given up and the
 * failure goes to `onError`, which logs it unless told otherwise, so a lost
 * collector never fails the platform awaiting a flush. Anything else is a
 * fault here, and is thrown.
 */

export interface CollectorOptions {
  /** The collector's origin, such as `https://api.agentrail.dev`. */
  readonly endpoint: string;
  /** The source's secret, as created for this component. */
  readonly secret: string;
  readonly component: Component;
  /** Events per call; the collector takes calls of up to 16 MB. */
  readonly batchSize?: number;
  /** Tries per call, the first included. */
  readonly attempts?: number;
  /**
   * How long one try may take, its answer read included, before it counts
   * as failed and is tried again; 10 s by default.
   */
  readonly timeoutMs?: number;
  /** Told of each call whose events were given up. Logs by default. */
  readonly onError?: (error: Error) => void;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface Collector {
  /** Queues an event for the next flush. */
  enqueue(event: AgentrailEvent): void;
  /** Sends everything queued; resolves when every call has ended. */
  flush(): Promise<void>;
}

/** The collector refused a call: trying again would be refused again. */
export class CollectorRefusedError extends Error {
  override readonly name = 'CollectorRefusedError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One try failed on the collector's side (a 5xx, a 429): worth another. */
export class CollectorFailedError extends Error {
  override readonly name = 'CollectorFailedError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** No call got through: the network, or the collector, failed every try. */
export class CollectorUnavailableError extends Error {
  override readonly name = 'CollectorUnavailableError';
}

const BACKOFF_MS = [250, 1_000];

function retriable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * The try outran its deadline. Fetch rejects with the signal's reason, a
 * `TimeoutError`; a runtime that does not pass the reason on rejects with an
 * `AbortError`, and the deadline's is the only signal a try has.
 */
function timedOut(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

export function createCollector(options: CollectorOptions): Collector {
  const {
    endpoint,
    secret,
    component,
    batchSize = 500,
    attempts = 3,
    timeoutMs = 10_000,
    onError = (error) => {
      console.error('agentrail: events were not sent', error);
    },
    fetch: send = fetch,
    sleep = (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  } = options;
  const url = new URL('/ingest/events', endpoint);
  const queue: AgentrailEvent[] = [];

  async function deliver(events: AgentrailEvent[]): Promise<void> {
    const body = JSON.stringify({
      component: { ...component, surfaces: [...component.surfaces] },
      events,
    });
    let last: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1];
      // One call after another: a retry waits out the failure before it.
      if (wait !== undefined) await sleep(wait);
      let response: Response;
      // What the collector said; a success says nothing more worth reading.
      let answer: string | null;
      try {
        // One deadline for the whole try: a collector that sends its headers
        // and never finishes its body holds the try no longer than one that
        // never answers.
        response = await send(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${secret}`,
            'content-type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        answer = response.ok ? null : await response.text();
      } catch (error) {
        // Fetch rejects only when the network failed, before or while the
        // answer arrived, or the deadline came first: nothing was read, so
        // the call is tried again.
        if (!(error instanceof TypeError) && !timedOut(error)) throw error;
        last = error;
        continue;
      }
      if (answer === null) {
        await response.body?.cancel();
        return;
      }
      if (!retriable(response.status))
        throw new CollectorRefusedError(
          response.status,
          `The collector refused ${String(events.length)} events (${String(response.status)}): ${answer}`,
        );
      last = new CollectorFailedError(
        response.status,
        `The collector answered ${String(response.status)}: ${answer}`,
      );
    }
    throw new CollectorUnavailableError(
      `${String(events.length)} events were not sent after ${String(attempts)} tries.`,
      { cause: last },
    );
  }

  return {
    enqueue(event) {
      queue.push(event);
    },

    async flush() {
      const events = queue.splice(0, queue.length);
      const batches: AgentrailEvent[][] = [];
      for (let at = 0; at < events.length; at += batchSize)
        batches.push(events.slice(at, at + batchSize));
      await Promise.all(
        batches.map(async (batch) => {
          try {
            await deliver(batch);
          } catch (error) {
            // Given up: told to onError, which logs unless told otherwise.
            if (
              error instanceof CollectorRefusedError ||
              error instanceof CollectorUnavailableError
            ) {
              onError(error);
              return;
            }
            throw error;
          }
        }),
      );
    },
  };
}
