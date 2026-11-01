import type { AgentrailEvent, Component } from './event.js';

/**
 * Sends a component's events to the collector, `POST <endpoint>/ingest/events`
 * with the source's secret: an edge sends each request's event after the
 * answer, through its platform's `waitUntil`, off the request's path.
 *
 * One call at a time. An event sent while no call is under way goes at once;
 * one sent while a call is under way waits, and goes with every other that
 * waited in the next call, as Kafka's producer batches with no linger: a
 * quiet site sends a call per event, a busy one about a call per round trip
 * to the collector. A call goes from a send still waiting on it: a platform
 * cancels what a request left running once its `waitUntil` has ended, so a
 * call never rides on a request that is done.
 *
 * A call that fails because the network or the collector did (no answer, a
 * 5xx, a 429, or no answer within the try's time) is tried again, after a
 * random part of 250 ms and then of 1 s, so components that failed together
 * do not try again together, and never sooner than a `Retry-After` the
 * collector sent; each try sends the same events, which the collector counts
 * as duplicates once stored. A call ends by its events' deadline: no try or
 * wait starts that would end past it. A call the collector refuses (any other
 * 4xx: a revoked secret, an event it cannot read) is not tried again. Either
 * way the events are given up and the failure goes to `onError`, which logs
 * it unless told otherwise, so a lost collector never fails the platform
 * awaiting a send. Anything else is a fault here, and is thrown.
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
   * as failed and is tried again; 10 s by default, and never past the
   * call's deadline.
   */
  readonly timeoutMs?: number;
  /** Told of each call whose events were given up. Logs by default. */
  readonly onError?: (error: Error) => void;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface Collector {
  /**
   * Sends an event, and resolves once the call carrying it has ended: taken,
   * or given up and told to `onError`. `deadline`, in milliseconds since the
   * epoch, is when that call must end, every try and wait included.
   */
  send(event: AgentrailEvent, deadline: number): Promise<void>;
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

/**
 * No call got through: the network, or the collector, failed every try, or
 * the deadline left no time for another.
 */
export class CollectorUnavailableError extends Error {
  override readonly name = 'CollectorUnavailableError';
}

/** The longest wait before each try after the first; each wait is a random part of it. */
const BACKOFF_MS = [250, 1_000];

function retriable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * How long a `Retry-After` asks to wait, in milliseconds: delay-seconds or an
 * HTTP date (RFC 9110, 10.2.3). Null for none, or for one that is neither: it
 * asks for nothing this client can read.
 */
function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d+$/u.test(text)) return Number(text) * 1_000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

interface Queued {
  readonly event: AgentrailEvent;
  readonly deadline: number;
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
  const queue: Queued[] = [];
  /** The calls under way; null when none is. */
  let out: Promise<void> | null = null;

  async function deliver(
    events: AgentrailEvent[],
    deadline: number,
  ): Promise<void> {
    const body = JSON.stringify({
      component: { ...component, surfaces: [...component.surfaces] },
      events,
    });
    let last: unknown = null;
    let tries = 0;
    // What the collector last asked a try to wait, at least.
    let asked: number | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const longest = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1];
      // One call after another: a retry waits out the failure before it.
      const wait =
        longest === undefined
          ? 0
          : Math.max(Math.random() * longest, asked ?? 0);
      if (Date.now() + wait >= deadline) break;
      if (longest !== undefined) await sleep(wait);
      const left = deadline - Date.now();
      if (left <= 0) break;
      tries += 1;
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
          signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
        });
        answer = response.ok ? null : await response.text();
      } catch (error) {
        // Fetch rejects only when the network failed, before or while the
        // answer arrived, or the deadline came first: nothing was read, so
        // the call is tried again.
        if (!(error instanceof TypeError) && !timedOut(error)) throw error;
        last = error;
        asked = null;
        continue;
      }
      if (answer === null) {
        try {
          await response.body?.cancel();
        } catch (error) {
          // The collector took the call: a body whose connection broke after
          // its status changes nothing it said.
          if (!(error instanceof TypeError)) throw error;
        }
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
      asked = retryAfterMs(response.headers.get('retry-after'), Date.now());
    }
    const outOfTime = tries < attempts;
    throw new CollectorUnavailableError(
      `${String(events.length)} events were not sent after ${String(tries)} ${tries === 1 ? 'try' : 'tries'}${outOfTime ? ', with no time left before their deadline' : ''}.`,
      last === null ? undefined : { cause: last },
    );
  }

  /** Sends what was taken off the queue, by the earliest deadline among it. */
  async function sendTaken(taken: Queued[]): Promise<void> {
    const deadline = Math.min(...taken.map((queued) => queued.deadline));
    const events = taken.map((queued) => queued.event);
    const batches: AgentrailEvent[][] = [];
    for (let at = 0; at < events.length; at += batchSize)
      batches.push(events.slice(at, at + batchSize));
    await Promise.all(
      batches.map(async (batch) => {
        try {
          await deliver(batch, deadline);
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
  }

  return {
    async send(event, deadline) {
      const queued: Queued = { event, deadline };
      queue.push(queued);
      // The call under way ends first, however it ends: the send that started
      // it reports a fault.
      while (out !== null) await Promise.allSettled([out]);
      // Carried by a call that has ended.
      if (!queue.includes(queued)) return;
      const calls = (async () => {
        try {
          await sendTaken(queue.splice(0, queue.length));
        } finally {
          out = null;
        }
      })();
      out = calls;
      // This send waits on the call it started, so the request it belongs to
      // keeps the call alive to its end.
      await calls;
    },
  };
}
