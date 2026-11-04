import type { SpanContext } from './event.js';
import { hashKeyIdOf } from './hash.js';
import { parseTraceparent } from './trace.js';

export const TRACE_HANDOFF_HEADER = 'x-agentrail-trace-handoff';
const MAX_AGE_MS = 60_000;
const encoder = new TextEncoder();
const TOKEN =
  /^ah1\.([0-9a-f]{16})\.(0|[1-9][0-9]{0,15})\.(00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2})\.([0-9a-f]{64})$/u;
const METHOD = /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/iu;
const keys = new Map<string, Promise<{ key: CryptoKey; id: string }>>();

export interface TraceHandoffInput {
  readonly traceparent: string;
  readonly hashKeyId: string;
  readonly issuedAt: number;
  readonly method: string;
  /** Exact origin-form target sent on the wire, after path/query rewrites. */
  readonly target: string;
}
interface Expectation {
  readonly traceparent: string | null;
  readonly method: string;
  readonly target: string;
  readonly now: number;
}
export interface TraceHandoffVerificationInput extends Expectation {
  readonly hashKey: string;
}
export interface TraceHandoffRefusal {
  readonly kind: 'refused';
  readonly reason:
    | 'missing'
    | 'malformed'
    | 'key_mismatch'
    | 'context_mismatch'
    | 'expired'
    | 'future'
    | 'signature_invalid';
}
interface Context {
  readonly context: SpanContext;
  readonly traceparent: string;
  readonly hashKeyId: string;
  readonly issuedAt: number;
}
export type TraceHandoffVerification =
  (Context & { readonly kind: 'verified' }) | TraceHandoffRefusal;

export class TraceHandoffInputError extends Error {
  override readonly name = 'TraceHandoffInputError';
  constructor() {
    super(
      'Configure a valid trace context, hash key ID, timestamp, method and origin-form target for trace handoff.',
    );
  }
}

async function keyOf(hashKey: string) {
  const held = keys.get(hashKey);
  if (held !== undefined) return held;
  const imported = Promise.all([
    crypto.subtle.importKey(
      'raw',
      encoder.encode(hashKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    ),
    hashKeyIdOf(hashKey),
  ]).then(([key, id]) => ({ key, id }));
  keys.set(hashKey, imported);
  return imported;
}

/** A fragment never reaches the origin; a trailing empty query still can. */
export function traceHandoffTarget(url: string | URL): string {
  const parsed = new URL(url);
  const fragmentAt = parsed.href.indexOf('#');
  const sent = fragmentAt < 0 ? parsed.href : parsed.href.slice(0, fragmentAt);
  return `${parsed.pathname}${parsed.search}${parsed.search === '' && sent.endsWith('?') ? '?' : ''}`;
}

function validRequest(method: string, target: string): boolean {
  return (
    METHOD.test(method) &&
    target.startsWith('/') &&
    target.isWellFormed() &&
    !/[\u0000\r\n#]/u.test(target)
  );
}

function payload(input: TraceHandoffInput): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    `agentrail.trace-handoff\u0000${JSON.stringify([
      1,
      input.hashKeyId,
      input.issuedAt,
      input.traceparent,
      input.method,
      input.target,
    ])}`,
  );
}

/** Shared canonical bytes for runtimes whose OTel hooks require synchronous HMAC. */
export function encodeTraceHandoff(input: TraceHandoffInput): {
  bytes: Uint8Array<ArrayBuffer>;
  tokenPrefix: string;
} {
  if (
    !/^[0-9a-f]{16}$/u.test(input.hashKeyId) ||
    input.traceparent !== input.traceparent.trim() ||
    parseTraceparent(input.traceparent) === null ||
    !Number.isSafeInteger(input.issuedAt) ||
    input.issuedAt < 0 ||
    !validRequest(input.method, input.target)
  )
    throw new TraceHandoffInputError();
  return {
    bytes: payload(input),
    tokenPrefix: `ah1.${input.hashKeyId}.${input.issuedAt}.${input.traceparent}.`,
  };
}

export async function signTraceHandoff(
  input: TraceHandoffInput,
  hashKey: string,
): Promise<string> {
  const key = await keyOf(hashKey);
  if (input.hashKeyId !== key.id) throw new TraceHandoffInputError();
  const encoded = encodeTraceHandoff(input);
  const mac = await crypto.subtle.sign('HMAC', key.key, encoded.bytes);
  const hex = [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return encoded.tokenPrefix + hex;
}

function parsedToken(token: string) {
  if (token.length > 256) return null;
  const [, hashKeyId, time, traceparent, signature] = TOKEN.exec(token) ?? [];
  if (
    hashKeyId === undefined ||
    time === undefined ||
    traceparent === undefined ||
    signature === undefined
  )
    return null;
  const context = parseTraceparent(traceparent);
  const issuedAt = Number(time);
  if (context === null || !Number.isSafeInteger(issuedAt)) return null;
  return {
    hashKeyId,
    issuedAt,
    traceparent,
    context,
    signature: Uint8Array.from({ length: 32 }, (_, index) =>
      Number.parseInt(signature.slice(index * 2, index * 2 + 2), 16),
    ),
  };
}

/**
 * Unverified candidate only. Node's synchronous OTel propagator checks its MAC
 * with node:crypto; other runtimes use verifyTraceHandoff below. Never continue
 * a trace from this result until the signature over bytes has been verified.
 */
export function readTraceHandoff(
  token: string | null,
  expected: Expectation & { readonly hashKeyId: string },
):
  | (Context & {
      readonly kind: 'candidate';
      readonly bytes: Uint8Array<ArrayBuffer>;
      readonly signature: Uint8Array<ArrayBuffer>;
    })
  | TraceHandoffRefusal {
  if (token === null) return { kind: 'refused', reason: 'missing' };
  const parsed = parsedToken(token);
  if (
    parsed === null ||
    !validRequest(expected.method, expected.target) ||
    !Number.isSafeInteger(expected.now)
  )
    return { kind: 'refused', reason: 'malformed' };
  if (parsed.hashKeyId !== expected.hashKeyId)
    return { kind: 'refused', reason: 'key_mismatch' };
  if (parsed.traceparent !== expected.traceparent)
    return { kind: 'refused', reason: 'context_mismatch' };
  const age = expected.now - parsed.issuedAt;
  if (age < 0) return { kind: 'refused', reason: 'future' };
  if (age > MAX_AGE_MS) return { kind: 'refused', reason: 'expired' };
  return {
    ...parsed,
    kind: 'candidate',
    bytes: payload({
      ...parsed,
      method: expected.method,
      target: expected.target,
    }),
  };
}

export async function verifyTraceHandoff(
  token: string | null,
  input: TraceHandoffVerificationInput,
): Promise<TraceHandoffVerification> {
  const key = await keyOf(input.hashKey);
  const candidate = readTraceHandoff(token, { ...input, hashKeyId: key.id });
  if (candidate.kind === 'refused') return candidate;
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      key.key,
      candidate.signature,
      candidate.bytes,
    ))
  )
    return { kind: 'refused', reason: 'signature_invalid' };
  return {
    kind: 'verified',
    context: candidate.context,
    traceparent: candidate.traceparent,
    hashKeyId: candidate.hashKeyId,
    issuedAt: candidate.issuedAt,
  };
}
