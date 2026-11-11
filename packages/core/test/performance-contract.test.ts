import { checkIngestRequest, ContractViolationError } from 'agentrail-contract';
import { expect, it } from 'vitest';
import { COMPONENT, event } from './support/event.js';

// Fails if the exported contract loses the collector's named-event-or-invocation requirement.
it('requires a named event or plugin invocation for operation evidence in the exported contract', () => {
  const operation = {
    namespaceId: '11111111-1111-4111-8111-111111111111',
    operationHash: 'a'.repeat(64),
    environment: 'production',
    role: 'start',
    eventName: null,
    plugin: null,
  };
  const body = (performance: object) => ({
    component: { ...COMPONENT, hashKeyId: '0123456789abcdef' },
    events: [{ ...event('contract-evidence'), performance }],
  });
  expect(() => {
    checkIngestRequest(body(operation));
  }).toThrow(ContractViolationError);
  const plugin = {
    bindingId: '22222222-2222-4222-8222-222222222222',
    invocationId: 'opaque',
  };
  checkIngestRequest(body({ ...operation, eventName: 'delivery.requested' }));
  checkIngestRequest(body({ ...operation, plugin }));
  checkIngestRequest(
    body({
      ...operation,
      namespaceId: null,
      operationHash: null,
      role: null,
      plugin,
    }),
  );
});
