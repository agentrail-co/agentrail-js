import type {
  Fingerprint as CollectorFingerprint,
  Frame as CollectorFrame,
  FrameBatch as CollectorFrameBatch,
} from '@argus/journey-linkage';
import { describe, expectTypeOf, it } from 'vitest';

import type { Fingerprint, Frame, FrameBatch } from '../src/index.js';

/**
 * The script keeps the collector's shapes as its own, without importing the
 * engine, which stays private: each must be the other. A frame the script
 * sends the collector would refuse, or one it reads the script never sends,
 * fails to compile here. (Every test reads what the script sent with the
 * engine's own schemas too: `support/page.ts`.)
 */
describe("the script's wire shapes and the collector's", () => {
  it('are one shape each way', () => {
    expectTypeOf<Frame>().toExtend<CollectorFrame>();
    expectTypeOf<CollectorFrame>().toExtend<Frame>();
    expectTypeOf<FrameBatch>().toExtend<CollectorFrameBatch>();
    expectTypeOf<CollectorFrameBatch>().toExtend<FrameBatch>();
    expectTypeOf<Fingerprint>().toExtend<CollectorFingerprint>();
    expectTypeOf<CollectorFingerprint>().toExtend<Fingerprint>();
  });
});
