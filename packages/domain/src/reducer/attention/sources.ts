import { RESERVED_SOURCE_PREFIX } from "@taskville/protocol";

/** The only source whose requests are answerable: the engine's permission bridge (M4). */
export const BRIDGE_SOURCE_ID = `${RESERVED_SOURCE_PREFIX}bridge`;

/**
 * True when an event comes from the engine itself. Ingest already rejects engine-only types from
 * any other source; the reducer checks again so a projection never trusts a forged closure.
 */
export const isEngineSource = (sourceId: string): boolean =>
  sourceId.startsWith(RESERVED_SOURCE_PREFIX);
