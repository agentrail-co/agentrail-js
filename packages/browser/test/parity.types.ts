import type {
  Fingerprint as CollectorFingerprint,
  Frame as CollectorFrame,
  FrameBatch as CollectorFrameBatch,
} from '@argus/journey-linkage';

import type { Fingerprint, Frame, FrameBatch } from '../src/index.js';

/**
 * The script keeps the collector's shapes as its own, without importing the
 * engine, which stays private: each must be the other. A frame the script
 * sends the collector would refuse, or one it reads the script never sends,
 * fails `typecheck` here; nothing in this file runs. (Every test reads what
 * the script sent with the engine's own schemas too: `support/page.ts`.)
 */

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;

export type Shapes = [
  Holds<Same<Frame, CollectorFrame>>,
  Holds<Same<FrameBatch, CollectorFrameBatch>>,
  Holds<Same<Fingerprint, CollectorFingerprint>>,
];
