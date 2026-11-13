import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';

/**
 * What the Argus collector takes and how its engine reads a marker, from
 * `sdk-contract.json` (README.md): the engine is private to Argus, so these
 * packages' tests check what they build against this instead.
 */

interface Contract {
  readonly ingestRequest: IngestRequestSchema;
  readonly browserCall: object;
  readonly browserPayloadCall: object;
  readonly markers: Markers;
  readonly traceHandoff: TraceHandoffContract;
  readonly otlp: OtlpContract;
}

export interface TraceHandoffContract {
  readonly header: string;
  readonly maxAgeMs: number;
  readonly fixtures: readonly {
    readonly hashKey: string;
    readonly token: string;
    readonly input: {
      readonly traceparent: string;
      readonly hashKeyId: string;
      readonly issuedAt: number;
      readonly method: string;
      readonly target: string;
    };
  }[];
}
export interface OtlpContract {
  readonly traces: { readonly path: string; readonly messageType: string };
  readonly logs: { readonly path: string; readonly messageType: string };
  readonly resourceAttributes: Readonly<Record<string, string>>;
  readonly spanAttributes: Readonly<
    Record<
      | 'verifiedIdentity'
      | 'principalKind'
      | 'principalHash'
      | 'actingUserHash'
      | 'clientAddressHash'
      | 'explicitStep'
      | 'stepSurface'
      | 'stepKind'
      | 'verifiedIngress'
      | 'operationNamespace'
      | 'operationHash'
      | 'performanceEnvironment'
      | 'workflowRole'
      | 'workflowEventName'
      | 'pluginBinding'
      | 'pluginInvocation',
      string
    >
  >;
  readonly logAttributes: Readonly<Record<string, string>>;
  /** The MCP attributes the collector reads, by role. */
  readonly mcpAttributes: Readonly<
    Record<
      | 'layer'
      | 'method'
      | 'sessionHash'
      | 'errorCode'
      | 'isError'
      | 'requestBytes'
      | 'responseBytes'
      | 'requestPayload'
      | 'responsePayload'
      | 'requestTruncated'
      | 'responseTruncated'
      | 'clientName'
      | 'clientVersion'
      | 'protocolVersion',
      string
    >
  >;
  /** What an MCP span is, in words: its name, layers, error types, sizes, session and payloads. */
  readonly mcpSpans: Readonly<
    Record<
      | 'name'
      | 'transport'
      | 'errorTypes'
      | 'handler'
      | 'sizes'
      | 'session'
      | 'payloads',
      string
    >
  >;
  readonly limits: {
    readonly bodyBytes: number;
    readonly records: number;
    readonly recordIdCharacters: number;
    readonly selectedTextCharacters: number;
    /** A span's two MCP payloads together, UTF-8, at most. */
    readonly mcpPayloadBytes: number;
    /** An SDK closes an export batch before its size passes this. */
    readonly exportBatchBytes: number;
  };
  readonly fixtures: {
    readonly accepted: readonly {
      readonly name: string;
      readonly signal: 'traces' | 'logs';
      readonly request: unknown;
      readonly expected: {
        readonly spans: number;
        readonly events: readonly unknown[];
        readonly logs: readonly unknown[];
        /** What the collector reads of each MCP transport span. */
        readonly mcp?: readonly McpCallFacts[];
        readonly payloads?: readonly (McpPayloadFacts | null)[];
      };
    }[];
    readonly refused: readonly {
      readonly name: string;
      readonly signal: 'traces' | 'logs';
      readonly request: unknown;
    }[];
  };
}

export interface McpCallFacts {
  readonly layer: 'transport' | 'handler';
  readonly method: string;
  readonly errorCode: number | null;
  readonly isError: boolean | null;
  readonly requestBytes: number | null;
  readonly responseBytes: number | null;
}
export interface McpPayloadFacts {
  readonly request: string | null;
  readonly response: string | null;
  readonly requestTruncated: boolean;
  readonly responseTruncated: boolean;
}

/** The part of the ingest body's schema a test reads directly. */
interface IngestRequestSchema {
  readonly properties: {
    readonly component: {
      readonly properties: {
        readonly surfaces: { readonly items: { readonly enum: string[] } };
      };
    };
  };
}

export interface Markers {
  readonly maxLinkIndex: number;
  /** A marker minted from eight random bytes, given as hex. */
  readonly minted: readonly {
    readonly random: string;
    readonly marker: string;
  }[];
  readonly linked: readonly {
    readonly marker: string;
    readonly lane: number;
    readonly linked: string;
  }[];
  /** The engine reading a raw value as an agent sent it back. */
  readonly parsed: readonly {
    readonly raw: string;
    readonly result:
      | {
          readonly valid: true;
          readonly base: string;
          readonly link: number | null;
        }
      | {
          readonly valid: false;
          readonly reason: 'length' | 'alphabet' | 'check';
        };
  }[];
}

// A path, not a URL: under jsdom, the browser package's tests' global URL is
// the page's, which Node's file system does not take.
const contract = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'sdk-contract.json'),
    'utf8',
  ),
) as Contract;

export const TRACE_HANDOFF = contract.traceHandoff;
export const OTLP = contract.otlp;

// Strict: a schema JSON Schema forbids is refused here, not read loosely.
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat('date-time', fullFormats['date-time']);

/** A body the collector would refuse. */
export class ContractViolationError extends Error {
  override readonly name = 'ContractViolationError';
}

function checker(validate: ValidateFunction, route: string) {
  return (body: unknown): void => {
    if (!validate(body))
      throw new ContractViolationError(
        `The collector would refuse this ${route} body: ${ajv.errorsText(validate.errors)}`,
      );
  };
}

/** Throws unless `POST /ingest/events` takes `body`. */
export const checkIngestRequest = checker(
  ajv.compile(contract.ingestRequest),
  'POST /ingest/events',
);

/** Throws unless `POST /ingest/browser` takes `body`. */
export const checkBrowserCall = checker(
  ajv.compile(contract.browserCall),
  'POST /ingest/browser',
);

/** Throws unless `POST /ingest/browser/payloads` takes `body`. */
export const checkBrowserPayloadCall = checker(
  ajv.compile(contract.browserPayloadCall),
  'POST /ingest/browser/payloads',
);

/** The surfaces the collector takes, in its order. */
export const SURFACES: readonly string[] =
  contract.ingestRequest.properties.component.properties.surfaces.items.enum;

export const MARKERS: Markers = contract.markers;

/** Eight random bytes, from the contract's hex. */
export function bytesOf(hex: string): Uint8Array {
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}
