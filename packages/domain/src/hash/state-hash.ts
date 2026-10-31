import { canonicalJson } from "./canonical-json.ts";
import { sha256Hex } from "./sha256.ts";

/**
 * SHA-256 of the canonical JSON of `value`, as 64 lowercase hex characters.
 * Used for event content hashes (dedupe) and as the body of stateHash.
 * Throws CanonicalJsonError if `value` has no canonical JSON form.
 */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * State hash of a reducer state: `<reducerVersion>:<hashCanonical(state)>`, for
 * example `3:9f86...`. The prefix keeps hashes from different reducer versions
 * from ever comparing equal (research R-7). `reducerVersion` must be a
 * non-negative safe integer, matching `projections.reducer_version INTEGER`.
 */
export function stateHash(reducerVersion: number, state: unknown): string {
  if (!Number.isSafeInteger(reducerVersion) || reducerVersion < 0) {
    throw new RangeError(`stateHash: reducerVersion must be a non-negative safe integer`);
  }
  return `${reducerVersion}:${hashCanonical(state)}`;
}
