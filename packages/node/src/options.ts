import { reportWithoutCapture } from './suppression.js';
import { randomUUID } from 'node:crypto';
import type { PrincipalKind, Surface, IpLocation } from 'agentrail-core';

export interface VerifiedIdentity {
  readonly kind: PrincipalKind;
  /** An ID the application has already authenticated. Never supplied from a request claim alone. */
  readonly id: string;
  readonly actingUserId?: string;
}
export interface AuthorizedOperation {
  readonly namespaceId: string;
  /** A business attempt ID the application has already authorized. Hashed locally; never exported. */
  readonly instanceRef: string;
  readonly role: 'start' | 'progress' | 'terminal';
}
export interface PluginInvocation {
  readonly bindingId: string;
  /** An opaque invocation ID, never tool arguments or a user identifier. */
  readonly invocationId: string;
}
export type PerformanceContext = {
  readonly environment: 'production' | 'test';
} & (
  | {
      readonly operation: AuthorizedOperation;
      readonly eventName: string;
      readonly plugin?: PluginInvocation;
    }
  | {
      readonly operation: AuthorizedOperation;
      readonly eventName?: string;
      readonly plugin: PluginInvocation;
    }
  | {
      readonly operation?: never;
      readonly eventName?: never;
      readonly plugin: PluginInvocation;
    }
);
export interface MilestoneContext {
  /** Explicit evidence supplied after application authorization; never inferred from tool inputs or results. */
  readonly performance?: PerformanceContext;
  readonly surface: Surface;
  readonly kind: string;
  readonly mcp?: {
    readonly method: string;
    readonly client?: string;
    readonly clientVersion?: string;
    readonly protocol?: string;
  };
}
export interface QueueOptions {
  readonly maxRecords: number;
  readonly batchSize: number;
  readonly scheduledDelayMs: number;
  readonly exportTimeoutMs: number;
  readonly flushTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}
export interface NodeOptions {
  /** Retain customer propagation for unmanaged work; register the returned SDK propagator once. */
  readonly propagator?: import('@opentelemetry/api').TextMapPropagator;
  readonly collector: { readonly endpoint: string; readonly secret: string };
  readonly hashKey: string;
  readonly serviceName: string;
  readonly serviceInstanceId?: string;
  /** Exact http(s) origins permitted to receive signed trace context. Defaults to none. */
  readonly outboundOrigins?: readonly string[];
  readonly ignoreIncomingRequest?: (
    request: import('node:http').IncomingMessage,
  ) => boolean;
  /** Use trusted platform metadata or a preloaded local database; never the exporter connection's IP. */
  readonly incomingLocation?: (
    request: import('node:http').IncomingMessage,
  ) => Omit<IpLocation, 'observedAt'> | null;
  readonly logs?: {
    readonly includeFields?: readonly string[];
    readonly uncorrelated?: boolean;
  };
  readonly queue?: Partial<QueueOptions>;
  readonly onError?: (error: CaptureError) => void;
}
export type CaptureCode =
  | 'queue_full'
  | 'export_failed'
  | 'deadline'
  | 'closed'
  | 'handoff_refused'
  | 'entry_not_recording'
  | 'location_failed'
  | 'identity_outside_request'
  | 'invalid_performance';
export class CaptureError extends Error {
  override readonly name = 'AgentrailCaptureError';
  constructor(
    readonly code: CaptureCode,
    readonly signal: 'traces' | 'logs' | 'context',
    readonly count: number,
    cause?: Error,
  ) {
    super(
      `Agentrail ${signal} capture: ${code} (${count} records).`,
      cause === undefined ? undefined : { cause },
    );
  }
}
export class ConfigurationError extends Error {
  override readonly name = 'AgentrailConfigurationError';
}
export interface ResolvedOptions {
  readonly input: NodeOptions;
  readonly endpoint: string;
  readonly instance: string;
  readonly origins: ReadonlySet<string>;
  readonly queue: QueueOptions;
  readonly report: (error: CaptureError) => void;
}
const defaults: QueueOptions = {
  maxRecords: 2048,
  batchSize: 128,
  scheduledDelayMs: 1000,
  exportTimeoutMs: 5000,
  flushTimeoutMs: 10000,
  shutdownTimeoutMs: 10000,
};
export function resolveOptions(input: NodeOptions): ResolvedOptions {
  const endpoint = new URL(input.collector.endpoint);
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new ConfigurationError(
      'Use an http(s) OTLP base URL without credentials, query or fragment.',
    );
  if (
    ![
      input.collector.secret,
      input.hashKey,
      input.serviceName,
      input.serviceInstanceId ?? 'present',
    ].every((value) => value.length > 0)
  )
    throw new ConfigurationError(
      'Configure a source secret, workspace hash key and service identity.',
    );
  if (
    [input.serviceName, input.serviceInstanceId].some(
      (value) =>
        value !== undefined &&
        (value.length > 4096 ||
          value.includes('\u0000') ||
          !value.isWellFormed()),
    )
  )
    throw new ConfigurationError(
      'Service names and instance IDs must be well-formed text of at most 4096 characters without NUL.',
    );
  const queue = { ...defaults, ...input.queue };
  if (
    !Object.values(queue).every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    queue.batchSize > queue.maxRecords ||
    queue.exportTimeoutMs >
      Math.min(queue.flushTimeoutMs, queue.shutdownTimeoutMs)
  )
    throw new ConfigurationError(
      'Use positive queue limits, batchSize <= maxRecords and deadlines >= exportTimeoutMs.',
    );
  const origins = new Set(
    (input.outboundOrigins ?? []).map((origin) => {
      const url = new URL(origin);
      if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol))
        throw new ConfigurationError(
          'outboundOrigins must contain exact http(s) origins.',
        );
      return origin;
    }),
  );
  return {
    input,
    endpoint: endpoint.href.replace(/\/$/u, ''),
    instance: input.serviceInstanceId ?? randomUUID(),
    origins,
    queue,
    report: (error) => {
      reportWithoutCapture(() => {
        if (input.onError === undefined) {
          console.error(error);
          return;
        }
        try {
          input.onError(error);
        } catch (callbackError) {
          console.error(
            'Agentrail onError callback failed.',
            callbackError,
            error,
          );
        }
      });
    },
  };
}
