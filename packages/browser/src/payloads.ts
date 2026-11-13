import type { AgentrailEvent, Component } from 'agentrail-core';

import {
  BrowserCollectorRefusedError,
  BrowserCollectorUnavailableError,
  MAX_CALL_BYTES,
} from './transport.js';

/**
 * A WebMCP tool run with the content its page captured
 * (`POST /ingest/browser/payloads`), for a site that turned payload capture
 * on. It goes as JSON text while the page is open, by a plain fetch: a
 * payload can be far larger than what a closing page may still send.
 */
export interface BrowserPayloadCall {
  readonly key: string;
  readonly component: Component;
  readonly tab: string;
  readonly event: AgentrailEvent;
  readonly payload: {
    /** The arguments' JSON text, after the site's redact hook. */
    readonly request: string | null;
    /** The result's JSON text, after the site's redact hook. */
    readonly response: string | null;
    readonly requestTruncated: boolean;
    readonly responseTruncated: boolean;
  };
}

/** The most the collector takes in one payload call. */
const MAX_PAYLOAD_CALL_BYTES = 16 * 1024 * 1024;

export interface PayloadOptions {
  /** The collector's `POST /ingest/browser/payloads`. */
  readonly endpoint: string;
  readonly key: string;
  readonly tab: string;
  readonly component: Component;
  readonly fetch: typeof fetch;
  readonly beacon: ((url: string, data: Blob) => boolean) | null;
  readonly onError: (error: Error) => void;
  /** Sends a run's event without its payload, as every other event goes. */
  readonly alone: (event: AgentrailEvent) => void;
}

const encoder = new TextEncoder();
const sizeOf = (value: unknown) =>
  encoder.encode(JSON.stringify(value)).byteLength;

/** The payloads route beside the collector's `POST /ingest/browser`. */
export function payloadsEndpoint(collector: string): string {
  const url = new URL(collector);
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/payloads`;
  return url.href;
}

/**
 * The longest start of `text` whose JSON string takes at most `limit` bytes
 * less its quotes. It never ends in half a surrogate pair, which the
 * collector refuses: JSON writes a lone surrogate as a six-byte escape, more
 * than the whole pair's four, so a start that fits with half a pair fits
 * with all of it.
 */
function cut(text: string, limit: number): string {
  const fits = (length: number) => sizeOf(text.slice(0, length)) - 2 <= limit;
  // Every UTF-16 unit takes at least a byte.
  let low = 0;
  let high = Math.min(text.length, limit);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

/** The call, its payloads cut only as far as it needs to fit `budget` bytes. */
export function fitted(
  call: BrowserPayloadCall,
  budget: number,
): BrowserPayloadCall {
  if (sizeOf(call) <= budget) return call;
  const { request, response } = call.payload;
  const room =
    budget -
    sizeOf({
      ...call,
      payload: {
        request: request === null ? null : '',
        response: response === null ? null : '',
        requestTruncated: false,
        responseTruncated: false,
      },
    });
  const requestSize = request === null ? 0 : sizeOf(request) - 2;
  const responseSize = response === null ? 0 : sizeOf(response) - 2;
  // Each gets half; one that needs less leaves the rest to the other.
  const half = Math.floor(Math.max(room, 0) / 2);
  const requestLimit =
    requestSize <= half ? requestSize : Math.max(half, room - responseSize);
  const responseLimit = Math.max(room - requestLimit, 0);
  const requestTruncated = request !== null && requestSize > requestLimit;
  const responseTruncated = response !== null && responseSize > responseLimit;
  return {
    ...call,
    payload: {
      request:
        request === null || !requestTruncated
          ? request
          : cut(request, requestLimit),
      response:
        response === null || !responseTruncated
          ? response
          : cut(response, responseLimit),
      requestTruncated,
      responseTruncated,
    },
  };
}

export interface Payloads {
  send(
    event: AgentrailEvent,
    request: string | null,
    response: string | null,
  ): void;
  /**
   * The page is closing: each payload still on its way goes again as a
   * beacon, cut to a closing page's call budget; one the browser would not
   * queue goes as its event alone.
   */
  close(): void;
}

export function createPayloads(options: PayloadOptions): Payloads {
  /** Sent by fetch and not yet answered, by event id. */
  const pending = new Map<string, BrowserPayloadCall>();
  const base = {
    key: options.key,
    component: options.component,
    tab: options.tab,
  };
  const headers = { 'content-type': 'text/plain;charset=UTF-8' };

  /** A payload that never arrived: its event still goes, alone. */
  function lost(id: string, error: Error): void {
    const call = pending.get(id);
    // Already sent again as the page closed.
    if (call === undefined) return;
    pending.delete(id);
    options.onError(error);
    options.alone(call.event);
  }

  return {
    send(event, request, response) {
      const call = fitted(
        {
          ...base,
          event,
          payload: {
            request,
            response,
            requestTruncated: false,
            responseTruncated: false,
          },
        },
        MAX_PAYLOAD_CALL_BYTES,
      );
      pending.set(event.id, call);
      options
        .fetch(options.endpoint, {
          method: 'POST',
          // Text, so a cross-origin call needs no preflight.
          headers,
          body: JSON.stringify(call),
          credentials: 'omit',
        })
        .then(
          (answer) => {
            if (answer.ok) pending.delete(event.id);
            else
              lost(event.id, new BrowserCollectorRefusedError(answer.status));
          },
          (error: unknown) => {
            // Fetch rejects only when the call never got an answer.
            if (!(error instanceof TypeError)) throw error;
            lost(
              event.id,
              new BrowserCollectorUnavailableError(error.message, {
                cause: error,
              }),
            );
          },
        );
    },
    close() {
      for (const call of pending.values()) {
        const body = JSON.stringify(fitted(call, MAX_CALL_BYTES));
        if (options.beacon === null)
          void options
            .fetch(options.endpoint, {
              method: 'POST',
              headers,
              body,
              keepalive: true,
              credentials: 'omit',
            })
            .catch((error: unknown) => {
              if (!(error instanceof TypeError)) throw error;
              options.onError(
                new BrowserCollectorUnavailableError(error.message, {
                  cause: error,
                }),
              );
            });
        else if (
          !options.beacon(
            options.endpoint,
            new Blob([body], { type: 'text/plain;charset=UTF-8' }),
          )
        )
          options.alone(call.event);
      }
      pending.clear();
    },
  };
}
