import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createContextKey } from '@opentelemetry/api';
import type { Attributes, Context, Span } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { VERSION } from 'agentrail-core';
import type {
  MilestoneContext,
  ResolvedOptions,
  VerifiedIdentity,
} from './options.js';

export interface State {
  location?: Omit<import('agentrail-core').IpLocation, 'observedAt'> | null;
  identity?: Attributes;
  readonly verifiedIngress: boolean;
  readonly links: import('@opentelemetry/api').Link[];
  readonly entry: { span?: Span };
}
export interface Mark extends Omit<MilestoneContext, 'performance'> {
  readonly performance?: Attributes;
  readonly name: string;
  readonly identity?: Attributes;
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
  identity(identity: VerifiedIdentity): Attributes {
    const hash = (id: string) =>
      createHmac('sha256', this.options.input.hashKey)
        .update(id)
        .digest('hex')
        .slice(0, 32);
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
