import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createContextKey } from '@opentelemetry/api';
import type { Attributes, Context, Span } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { VERSION } from 'agentrail-core';
import {
  ConfigurationError,
  type MilestoneContext,
  type ResolvedOptions,
  type VerifiedIdentity,
} from './options.js';

export interface State {
  location?: Omit<import('agentrail-core').IpLocation, 'observedAt'> | null;
  identity?: Attributes;
  readonly verifiedIngress: boolean;
  readonly links: import('@opentelemetry/api').Link[];
  readonly entry: { span?: Span };
}
/** What the MCP capture learns of one call, filled until its span ends. */
export interface McpFacts {
  readonly layer: 'transport' | 'handler';
  readonly method: string;
  sessionHash?: string;
  requestBytes?: number;
  responseBytes?: number;
  errorCode?: number;
  isError?: boolean;
  requestPayload?: string;
  responsePayload?: string;
  requestTruncated?: boolean;
  responseTruncated?: boolean;
}
export interface Mark extends Omit<MilestoneContext, 'performance'> {
  readonly performance?: Attributes;
  readonly name: string;
  readonly identity?: Attributes;
  /** False for a span that is not a step: an MCP handler inside its transport span. */
  readonly step?: false;
  readonly mcpFacts?: McpFacts;
}
export class Runtime {
  readonly stateKey = createContextKey(`agentrail.state.${randomUUID()}`);
  readonly markKey = createContextKey(`agentrail.milestone.${randomUUID()}`);
  readonly spans = new WeakMap<object, { state: State; mark?: Mark }>();
  readonly keyId: string;
  readonly resource;
  constructor(readonly options: ResolvedOptions) {
    this.keyId = createHash('sha256')
      .update(options.input.hashKey)
      .digest('hex')
      .slice(0, 16);
    this.resource = resourceFromAttributes({
      'service.name': options.input.serviceName,
      'service.instance.id': options.instance,
      'agentrail.component.name': 'agentrail-node',
      'agentrail.component.version': VERSION,
      'agentrail.hash_key_id': this.keyId,
      'agentrail.capture.surfaces': 'http,mcp,auth,custom',
    });
  }
  state(ctx: Context): State | undefined {
    return ctx.getValue(this.stateKey) as State | undefined;
  }
  mark(ctx: Context): Mark | undefined {
    return ctx.getValue(this.markKey) as Mark | undefined;
  }
  newState(verifiedIngress = false, links: State['links'] = []): State {
    return { verifiedIngress, links, entry: {} };
  }
  /** The keyed hash every principal and session ID is sent as: 32 lowercase hex. */
  hash(id: string): string {
    return createHmac('sha256', this.options.input.hashKey)
      .update(id)
      .digest('hex')
      .slice(0, 32);
  }
  identity(identity: VerifiedIdentity): Attributes {
    const hash = (id: string) => this.hash(id);
    return {
      'agentrail.identity.verified': true,
      'agentrail.principal.kind': identity.kind,
      'agentrail.principal.id_hash': hash(identity.id),
      ...(identity.actingUserId === undefined
        ? {}
        : {
            'agentrail.principal.acting_user_hash': hash(identity.actingUserId),
          }),
    };
  }
}

/** What the MCP adapter needs of a client, kept out of its public type. */
export interface Internal {
  readonly runtime: Runtime;
  /** Starts a marked span under the active context. */
  start(
    name: string,
    details: MilestoneContext,
    extra?: Pick<Mark, 'step' | 'mcpFacts'>,
  ): { span: Span; ctx: Context };
}
const internals = new WeakMap<object, Internal>();
export function registerInternal(client: object, internal: Internal): void {
  internals.set(client, internal);
}
export function internalOf(client: object): Internal {
  const internal = internals.get(client);
  if (internal === undefined)
    throw new ConfigurationError(
      'Pass the client that init or createProcessors returned.',
    );
  return internal;
}
