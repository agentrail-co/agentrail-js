import { subscribe, unsubscribe } from 'node:diagnostics_channel';

import { CLI_HEADER } from 'agentrail-core';

/**
 * Puts the header on the CLI's own requests as they are made, through the
 * channels Node publishes for them, so no client is patched: `fetch` and
 * undici publish `undici:request:create`, and `http.request` and
 * `https.request` (axios, got, node-fetch, most generated SDKs) publish
 * `http.client.request.created` before the request's headers are sent.
 * Bun and Deno publish neither; a CLI built with them calls `headers(url)`.
 */

/** Which requests may carry the header, and what the SDK puts on them. */
export interface RequestPolicy {
  /** Whether a request to `origin` may carry the header: one of the CLI's listed origins. */
  lists(origin: string): boolean;
  /** The header for a request to a listed origin; null when the SDK adds none itself. */
  header(origin: string): string | null;
  /** Told of a request to an origin not listed. */
  skipped?(origin: string): void;
}

/**
 * Every SDK watching in this process. A header comes off a request only
 * where none lists its origin: two in one CLI (a plugin's, say) never take
 * off what the other put on for its own API.
 */
const watching = new Set<RequestPolicy>();

function anyLists(origin: string | null): boolean {
  if (origin === null) return false;
  for (const policy of watching) if (policy.lists(origin)) return true;
  return false;
}

interface UndiciRequest {
  readonly origin: string | URL;
  /** A flat `[name, value, …]` list in undici 6 and later; a block of lines before. */
  headers: unknown;
  addHeader(name: string, value: string): unknown;
}

interface HttpRequest {
  readonly protocol: string;
  /** The host the request connects to, as `ClientRequest.host` names it: never the Host header. */
  readonly host: string;
  readonly headersSent: boolean;
  getHeader(name: string): unknown;
  hasHeader(name: string): boolean;
  setHeader(name: string, value: string): unknown;
  removeHeader(name: string): unknown;
}

const UNDICI = 'undici:request:create';
const HTTP = 'http.client.request.created';

function requestOf(message: unknown): unknown {
  return typeof message === 'object' && message !== null && 'request' in message
    ? message.request
    : undefined;
}

function isUndiciRequest(request: unknown): request is UndiciRequest {
  return (
    typeof request === 'object' &&
    request !== null &&
    'origin' in request &&
    'addHeader' in request &&
    typeof request.addHeader === 'function'
  );
}

function isHttpRequest(request: unknown): request is HttpRequest {
  return (
    typeof request === 'object' &&
    request !== null &&
    'protocol' in request &&
    'host' in request &&
    typeof request.host === 'string' &&
    'setHeader' in request &&
    typeof request.setHeader === 'function' &&
    'getHeader' in request &&
    typeof request.getHeader === 'function' &&
    'removeHeader' in request &&
    typeof request.removeHeader === 'function'
  );
}

/** Whether undici's headers already hold the header: the CLI put it on itself, with `headers(url)`. */
function undiciHas(headers: unknown): boolean {
  if (Array.isArray(headers))
    return headers.some(
      (value, index) =>
        index % 2 === 0 &&
        typeof value === 'string' &&
        value.toLowerCase() === CLI_HEADER,
    );
  return (
    typeof headers === 'string' &&
    headers.toLowerCase().includes(`${CLI_HEADER}:`)
  );
}

/** undici's headers without the header. */
function undiciWithout(headers: unknown): unknown {
  if (Array.isArray(headers)) {
    const kept: unknown[] = [];
    for (let index = 0; index < headers.length; index += 2) {
      const name: unknown = headers[index];
      if (typeof name === 'string' && name.toLowerCase() === CLI_HEADER)
        continue;
      kept.push(name, headers[index + 1]);
    }
    return kept;
  }
  return typeof headers === 'string'
    ? headers
        .split('\r\n')
        .filter((line) => !line.toLowerCase().startsWith(`${CLI_HEADER}:`))
        .join('\r\n')
    : headers;
}

/**
 * An origin as the CLI's options name one. A URL the WHATWG parser refuses
 * cannot be a request this process makes; such a request is left as it is.
 */
function originOf(text: string): string | null {
  try {
    return new URL(text).origin;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

/**
 * The origin an `http` request connects to. Its host is the request's own
 * (`ClientRequest.host`), never the Host header, which a caller may set to
 * any host; its port is the one the Host header names, which Node writes
 * from the request's own port unless the caller overrode it, and is taken
 * only when that header names the same host. Node publishes no port of its
 * own on the request, so one overridden to another port of the same host
 * goes unseen. Null where the two disagree: the header goes on no such
 * request, and comes off one the CLI put it on.
 */
function httpOriginOf(request: HttpRequest): string | null {
  const named = request.getHeader('host');
  if (typeof named !== 'string') return null;
  const origin = originOf(`${request.protocol}//${named}`);
  const ipv6 = request.host.includes(':') && !request.host.startsWith('[');
  const connected = originOf(
    `${request.protocol}//${ipv6 ? `[${request.host}]` : request.host}`,
  );
  if (origin === null || connected === null) return null;
  return new URL(origin).hostname === new URL(connected).hostname
    ? origin
    : null;
}

/**
 * Starts watching the CLI's requests; the function returned stops. A
 * request to a listed origin gets the header; one to any other origin never
 * carries it, though the CLI put it on itself (with `headers(url)`) and a
 * redirect took the request elsewhere, since `fetch` and follow-redirects
 * keep a request's headers from one origin to the next. A hook that threw
 * would end the CLI, as a throwing subscriber's error is thrown again
 * outside the request: every failure goes to `report`, and the request
 * goes out as it was.
 */
export function watchRequests(
  policy: RequestPolicy,
  report: (error: Error) => void,
): () => void {
  /** Tells `report`, which must not throw either: its error would end the CLI as the hook's would. */
  const tell = (error: unknown): void => {
    try {
      report(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // The CLI's own error handler failed: there is no one left to tell,
      // and the request goes out as it was.
    }
  };
  const onUndici = (message: unknown): void => {
    try {
      const request = requestOf(message);
      if (!isUndiciRequest(request)) return;
      const origin = originOf(String(request.origin));
      if (undiciHas(request.headers)) {
        if (!anyLists(origin)) request.headers = undiciWithout(request.headers);
        return;
      }
      if (origin === null) return;
      if (!policy.lists(origin)) {
        policy.skipped?.(origin);
        return;
      }
      const value = policy.header(origin);
      if (value !== null) request.addHeader(CLI_HEADER, value);
    } catch (error) {
      tell(error);
    }
  };
  const onHttp = (message: unknown): void => {
    try {
      const request = requestOf(message);
      if (!isHttpRequest(request) || request.headersSent) return;
      const origin = httpOriginOf(request);
      if (request.hasHeader(CLI_HEADER)) {
        if (!anyLists(origin)) request.removeHeader(CLI_HEADER);
        return;
      }
      if (origin === null) return;
      if (!policy.lists(origin)) {
        policy.skipped?.(origin);
        return;
      }
      const value = policy.header(origin);
      if (value !== null) request.setHeader(CLI_HEADER, value);
    } catch (error) {
      tell(error);
    }
  };
  watching.add(policy);
  subscribe(UNDICI, onUndici);
  subscribe(HTTP, onHttp);
  return () => {
    watching.delete(policy);
    unsubscribe(UNDICI, onUndici);
    unsubscribe(HTTP, onHttp);
  };
}
