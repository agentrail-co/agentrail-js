import { createHmac } from 'node:crypto';
import type { Attributes } from '@opentelemetry/api';
import { ConfigurationError, type PerformanceContext } from './options.js';
// Matches the collector's UUID contract, including version and variant.
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** Only normalized, allowlisted evidence enters the span context. */
export function performanceAttributes(
  input: PerformanceContext,
  hashKey: string,
): Attributes {
  const attributes: Attributes = { 'agentrail.environment': input.environment };
  if (input.plugin !== undefined) {
    if (
      !uuid.test(input.plugin.bindingId) ||
      input.plugin.invocationId.length === 0 ||
      input.plugin.invocationId.length > 256 ||
      !input.plugin.invocationId.isWellFormed() ||
      input.plugin.invocationId.includes('\u0000')
    )
      throw new ConfigurationError(
        'Use a canonical binding ID and an opaque invocation ID of 1–256 characters.',
      );
    attributes['agentrail.plugin.binding_id'] = input.plugin.bindingId;
    attributes['agentrail.plugin.invocation_id'] = input.plugin.invocationId;
  }
  if (input.operation !== undefined) {
    const { namespaceId, instanceRef, role } = input.operation;
    if (
      !uuid.test(namespaceId) ||
      instanceRef.length === 0 ||
      !instanceRef.isWellFormed()
    )
      throw new ConfigurationError(
        'Use a canonical namespace ID and a nonempty, well-formed authorized operation reference.',
      );
    attributes['agentrail.operation.namespace_id'] = namespaceId;
    attributes['agentrail.operation.hash'] = createHmac('sha256', hashKey)
      .update(JSON.stringify(['agentrail.operation', namespaceId, instanceRef]))
      .digest('hex');
    attributes['agentrail.workflow.role'] = role;
    if (input.eventName !== undefined) {
      if (
        input.eventName.length > 120 ||
        !/^[a-zA-Z][a-zA-Z0-9_.:-]*$/u.test(input.eventName)
      )
        throw new ConfigurationError(
          'Use a business event name of 1–120 letters, digits, dots, underscores, colons or hyphens, starting with a letter.',
        );
      attributes['agentrail.workflow.event_name'] = input.eventName;
    }
  }
  return attributes;
}
