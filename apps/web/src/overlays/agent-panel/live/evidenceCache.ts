import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";

export const EVIDENCE_BODY_CAPACITY = 128;

/** One shared input/output body budget. Feed metadata is retained separately. */
export function createEvidenceBodyCache() {
  const bodies = new Map<string, EvidenceResponse>();
  return {
    get size() {
      return bodies.size;
    },
    get(id: string) {
      const body = bodies.get(id);
      if (body) {
        bodies.delete(id);
        bodies.set(id, body);
      }
      return body;
    },
    set(body: EvidenceResponse) {
      bodies.delete(body.id);
      bodies.set(body.id, body);
      if (bodies.size > EVIDENCE_BODY_CAPACITY) {
        const oldest = bodies.keys().next().value;
        if (oldest !== undefined) bodies.delete(oldest);
      }
    },
    clear() {
      bodies.clear();
    },
  };
}
