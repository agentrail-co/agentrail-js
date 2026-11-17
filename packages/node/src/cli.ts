import type { Attributes } from '@opentelemetry/api';
import { CLI_HEADER, readCliHeader } from 'agentrail-core';

/**
 * What a customer's CLI said of itself on a request to this server, in its
 * `x-agentrail-cli` header (written by `agentrail-cli-sdk`), as the span
 * attributes the collector reads (the contract's `otlp.cliAttributes`).
 * The session leaves only as its keyed hash, as a principal's id does.
 * Undefined for a request with no header that reads, and for one that sent
 * it twice: Node would join the two into one value that reads as neither.
 */
export function cliAttributesOf(
  rawHeaders: readonly string[],
  hash: (id: string) => string,
): Attributes | undefined {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name?.toLowerCase() === CLI_HEADER && value !== undefined)
      values.push(value);
  }
  const [value] = values;
  if (values.length !== 1 || value === undefined) return undefined;
  const header = readCliHeader(value);
  if (header === null) return undefined;
  const attributes: Attributes = {
    'agentrail.cli.name': header.cli,
    'agentrail.cli.run_id': header.run,
    'agentrail.cli.sequence': header.sequence,
    'agentrail.cli.mode': header.mode,
    'agentrail.cli.session.id_hash': hash(header.session),
    'agentrail.cli.session.source': header.sessionFrom,
    'agentrail.cli.sdk.version': header.sdkVersion,
  };
  if (header.cliVersion !== undefined)
    attributes['agentrail.cli.version'] = header.cliVersion;
  if (header.command !== undefined)
    attributes['agentrail.cli.command'] = header.command;
  if (header.agent !== undefined)
    attributes['agentrail.cli.agent.name'] = header.agent;
  if (header.agentVersion !== undefined)
    attributes['agentrail.cli.agent.version'] = header.agentVersion;
  if (header.evidence !== undefined)
    attributes['agentrail.cli.agent.evidence'] = header.evidence.join(',');
  return attributes;
}
