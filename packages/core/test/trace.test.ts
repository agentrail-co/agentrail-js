import { describe, expect, it } from 'vitest';

import {
  formatTraceparent,
  newSpanId,
  newTraceId,
  parseTraceparent,
} from '../src/index.js';

describe('trace context', () => {
  // Fails if someone accepts W3C's invalid all-zero ids or another version:
  // a caller could name a parent no one can ever be linked to.
  it('reads a valid traceparent, and none that names the invalid ids', () => {
    const context = { traceId: newTraceId(), spanId: newSpanId() };
    expect(parseTraceparent(formatTraceparent(context))).toEqual(context);
    for (const header of [
      null,
      'garbage',
      `00-${'0'.repeat(32)}-${context.spanId}-01`,
      `00-${context.traceId}-${'0'.repeat(16)}-01`,
      `01-${context.traceId}-${context.spanId}-01`,
    ])
      expect(parseTraceparent(header)).toBeNull();
  });
});
