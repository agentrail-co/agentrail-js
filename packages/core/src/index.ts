/**
 * What every Agentrail component shares, in any runtime with the Fetch API
 * and WebCrypto: the event the collector takes, markers, the keyed hash,
 * trace context, and the client that sends events. Nothing here imports
 * Node, the DOM or OpenTelemetry.
 */
export {
  SURFACES,
  type AgentrailEvent,
  type ClockSource,
  type Component,
  type PrincipalKind,
  type RegistrationPhase,
  type SpanContext,
  type SpanKind,
  type Surface,
} from './event.js';
export {
  MARKER_PATTERN,
  MAX_LINK_INDEX,
  MarkerError,
  linkMarker,
  mintMarker,
  newMarker,
} from './marker.js';
export { hashKeyIdOf, keyedHash } from './hash.js';
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
