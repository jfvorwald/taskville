import type { StoredEnvelope } from "../../data/domain.ts";

/** Original recorded envelopes at a presentation boundary, never inferred from a snapshot. */
export interface FidelityFrame {
  readonly epoch: number;
  readonly revision: number;
  readonly events: readonly StoredEnvelope[];
  readonly baseline: readonly StoredEnvelope[];
}

export const EMPTY_FIDELITY_FRAME: FidelityFrame = {
  epoch: 0,
  revision: 0,
  events: [],
  baseline: [],
};
