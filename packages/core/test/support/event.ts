import type { AgentrailEvent } from '../../src/index.js';

/** The component the collector tests send as. */
export const COMPONENT = {
  name: '@agentrail/edge',
  version: '0.1.0',
  surfaces: ['edge'],
} as const;

/** The smallest event the collector takes, under `id`. */
export function event(id: string): AgentrailEvent {
  return {
    schemaVersion: 1,
    id,
    surface: 'edge',
    kind: 'http.request',
    start: 1,
    end: 2,
    clock: 'edge',
    emittedBy: 'argus',
    resource: { serviceName: 'www', serviceInstanceId: null },
    span: null,
    session: null,
    http: null,
    actor: { egress: null, userAgent: null, client: null },
    principal: null,
    registration: null,
    markers: { served: [], seen: [] },
    redactions: [],
  };
}
