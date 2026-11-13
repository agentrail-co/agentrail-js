import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';

interface Attribute {
  key: string;
  value: { stringValue?: string; boolValue?: boolean; intValue?: string };
}
export interface WireSpan {
  traceId: Buffer;
  status?: { code?: number };
  spanId: Buffer;
  parentSpanId?: Buffer;
  name: string;
  kind: number;
  attributes?: Attribute[];
  events?: unknown[];
  links?: { traceId: Buffer; spanId: Buffer }[];
}
export interface WireLog {
  traceId?: Buffer;
  spanId?: Buffer;
  body?: { stringValue?: string };
  severityNumber?: number;
  severityText?: string;
  eventName?: string;
  attributes?: Attribute[];
}
interface TraceRequest {
  resourceSpans?: {
    resource?: { attributes?: Attribute[] };
    scopeSpans?: { spans?: WireSpan[] }[];
  }[];
}
interface LogRequest {
  resourceLogs?: {
    resource?: { attributes?: Attribute[] };
    scopeLogs?: { logRecords?: WireLog[] }[];
  }[];
}
const root = protobuf.Root.fromJSON(
  JSON.parse(
    readFileSync(
      new URL('../fixtures/otlp-protocol.json', import.meta.url),
      'utf8',
    ),
  ) as protobuf.INamespace,
);
const traceRequest = root.lookupType(
  'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
);
const logRequest = root.lookupType(
  'opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest',
);

export async function collector(responses: readonly number[] = []) {
  const packets: {
    path: string;
    bytes: Buffer;
    authorization: string | undefined;
  }[] = [];
  let attempts = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (request.url === undefined) throw new Error('No test collector path.');
      packets.push({
        path: request.url,
        bytes: Buffer.concat(chunks),
        authorization: request.headers.authorization,
      });
      const status = responses[attempts++] ?? 200;
      if (status === 0) return; // Deliberately held response: export deadline fixture.
      response.writeHead(status, { 'content-type': 'application/x-protobuf' });
      response.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('No test collector port.');
  const traces = () =>
    packets
      .filter((packet) => packet.path.endsWith('/traces'))
      .map(
        (packet) =>
          traceRequest.toObject(traceRequest.decode(packet.bytes), {
            longs: String,
          }) as TraceRequest,
      );
  const logs = () =>
    packets
      .filter((packet) => packet.path.endsWith('/logs'))
      .map(
        (packet) =>
          logRequest.toObject(logRequest.decode(packet.bytes), {
            longs: String,
          }) as LogRequest,
      );
  return {
    endpoint: `http://127.0.0.1:${address.port}/ingest/otlp`,
    packets,
    spans: () =>
      traces()
        .flatMap((request) => request.resourceSpans ?? [])
        .flatMap((resource) => resource.scopeSpans ?? [])
        .flatMap((scope) => scope.spans ?? []),
    logs: () =>
      logs()
        .flatMap((request) => request.resourceLogs ?? [])
        .flatMap((resource) => resource.scopeLogs ?? [])
        .flatMap((scope) => scope.logRecords ?? []),
    resources: () =>
      traces()
        .flatMap((request) => request.resourceSpans ?? [])
        .map((resource) => attributesOf(resource.resource?.attributes)),
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

export function attributesOf(
  attributes: readonly Attribute[] | undefined,
): Record<string, string | boolean | number> {
  return Object.fromEntries(
    (attributes ?? []).flatMap(({ key, value }) => {
      const field =
        value.stringValue ??
        value.boolValue ??
        (value.intValue === undefined ? undefined : Number(value.intValue));
      return field === undefined ? [] : [[key, field]];
    }),
  );
}
