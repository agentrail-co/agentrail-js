/**
 * What every Agentrail component shares, in any runtime with the Fetch API
 * and WebCrypto: the event the collector takes, markers, the keyed hash,
 * trace context, the session, and the client that sends events. Nothing
 * here imports Node, the DOM or OpenTelemetry.
 */
export {
  SURFACES,
  type AgentrailEvent,
  type ClockSource,
  type Component,
  type PrincipalKind,
  type RegistrationPhase,
  type SignatureOutcome,
  type SpanContext,
  type SpanKind,
  type Surface,
} from './event.js';
export {
  MAX_LINK_INDEX,
  MarkerError,
  linkMarker,
  mintMarker,
  newMarker,
  parseMarker,
  type ParsedMarker,
} from './marker.js';
export {
  SessionTimeoutError,
  newSessionId,
  sessionCookie,
  sessionStartOf,
  type SessionCookie,
  type SessionCookieOptions,
} from './session.js';
export { hashKeyIdOf, keyedHash } from './hash.js';
export { newId } from './id.js';
export {
  KNOWN_SIGNERS,
  SIGNATURE_CHECK_OUTCOMES,
  createSignatureVerifier,
  keyThumbprint,
  type SignatureCheckOutcome,
  type SignatureVerifier,
  type SignatureVerifierOptions,
  type SignedAgent,
  type SignedRequest,
} from './web-bot-auth.js';
export { VERSION } from './version.js';
export {
  formatTraceparent,
  newSpanId,
  newTraceId,
  parseTraceparent,
} from './trace.js';
export {
  CollectorFailedError,
  CollectorRefusedError,
  CollectorUnavailableError,
  createCollector,
  type Collector,
  type CollectorOptions,
} from './collector.js';
