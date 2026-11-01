/**
 * One event as a component sends it to the collector (`POST /ingest/events`):
 * the journey engine's event less `tenant` and `observedAt`, which the
 * collector stamps from the source's workspace and its own clock, and
 * `hashKeyId`, which it stamps from the key the call names.
 *
 * The engine, private to Argus, holds the schema the collector checks; this
 * package holds the same shape as types, so no component imports the
 * engine. The edge's and the browser's tests check every call they send
 * against the contract Argus writes (`packages/contract`).
 */

export const SURFACES = [
  'edge',
  'firewall',
  'browser',
  'http',
  'mcp',
  'a2a',
  'genai',
  'auth',
  'payment',
  'custom',
] as const;
export type Surface = (typeof SURFACES)[number];

/** Whose clock wrote `start` and `end`. */
export type ClockSource = 'edge' | 'backend' | 'browser' | 'third_party';

export type SpanKind =
  'server' | 'client' | 'internal' | 'producer' | 'consumer';

/** What a verified principal is. Self-reported identity is never a principal. */
export type PrincipalKind =
  'user' | 'agent_registration' | 'agent_instance' | 'oauth_client' | 'api_key';

export type RegistrationPhase =
  'created' | 'claim_completed' | 'expired' | 'revoked';

export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
}

export interface AgentrailEvent {
  /** Bumped when a field's meaning changes; stored events are read back. */
  readonly schemaVersion: 1;
  /** Minted here, so a duplicate delivery is the same event. */
  readonly id: string;
  readonly surface: Surface;
  /** What happened, e.g. `http.request`, `tool.call`. */
  readonly kind: string;
  /** This component's clock, milliseconds since the epoch. */
  readonly start: number;
  /** Null for a point event. */
  readonly end: number | null;
  readonly clock: ClockSource;
  /** `argus` for our own components; `other` for anything else. */
  readonly emittedBy: 'argus' | 'other';
  /** OpenTelemetry resource: `service.name` and `service.instance.id`. */
  readonly resource: {
    readonly serviceName: string;
    readonly serviceInstanceId: string | null;
  };
  readonly span: {
    readonly traceId: string;
    readonly spanId: string;
    readonly parentSpanId: string | null;
    readonly kind: SpanKind;
    /** Entered from outside: a parent it names came from whoever called. */
    readonly publicEntry: boolean;
    readonly subtreeSpanIds: string[];
    readonly links: SpanContext[];
  } | null;
  /** `session.id` and `session.previous_id`, set by our edge. */
  readonly session: {
    readonly id: string;
    readonly previousId: string | null;
  } | null;
  readonly http: {
    readonly method: string;
    readonly host: string;
    /** The path with the allowlisted query. */
    readonly path: string;
    readonly status: number | null;
    readonly location: string | null;
    readonly contentType: string | null;
    /** The addresses on the site's own hosts a response named, as requested. */
    readonly linksOut: string[];
  } | null;
  /** Self-reported or network facts: features, never proofs. */
  readonly actor: {
    /** Keyed hash of the client address. */
    readonly egress: string | null;
    readonly userAgent: string | null;
    readonly client: string | null;
  };
  /** A verified identity, its ids keyed hashes. */
  readonly principal: {
    readonly kind: PrincipalKind;
    readonly id: string;
    readonly actingUserId: string | null;
  } | null;
  readonly registration: {
    readonly id: string;
    readonly phase: RegistrationPhase;
    readonly claimedBy: string | null;
  } | null;
  readonly markers: {
    /** Markers planted in this step's response. */
    readonly served: { readonly value: string; readonly durable: boolean }[];
    /** Marker strings found in this step's request, as received. */
    readonly seen: string[];
  };
  /** What was hashed or dropped here, and why. */
  readonly redactions: { readonly field: string; readonly reason: string }[];
}

/** The capture code that sent a call, and the surfaces it is set up to capture. */
export interface Component {
  readonly name: string;
  readonly version: string;
  readonly surfaces: readonly Surface[];
  /**
   * The id of the workspace hash key it hashes with (`hashKeyIdOf`); absent
   * for a component that hashes nothing. The collector refuses an event
   * carrying a hashed value in a call that names no key.
   */
  readonly hashKeyId?: string;
}
