import { describe, expect, it } from "vitest";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import { createEvidenceBodyCache } from "../../../../src/overlays/agent-panel/live/evidenceCache.ts";

function body(index: number, part: EvidenceResponse["part"] = "input"): EvidenceResponse {
  const projectId = "project-cache";
  const toolCallId = `call-${index}`;
  return {
    id: Buffer.from(JSON.stringify([projectId, toolCallId, part])).toString("base64url"),
    projectId,
    toolCallId,
    part,
    text: "synthetic body",
    masks: [],
    truncated: false,
    bytes: 14,
  };
}

describe("createEvidenceBodyCache", () => {
  it("retains exactly the newest 128 bodies without exceeding capacity on any insertion", () => {
    const cache = createEvidenceBodyCache();
    expect(cache.size).toBe(0);

    for (let index = 0; index < 256; index++) {
      cache.set(body(index));
      expect(cache.size).toBeLessThanOrEqual(128);
      expect(cache.size).toBe(Math.min(index + 1, 128));
    }

    expect(cache.size).toBe(128);
    for (let index = 0; index < 256; index++) {
      expect(cache.get(body(index).id)).toEqual(index < 128 ? undefined : body(index));
    }
  });

  it("replaces a response by its id without growing or evicting another body", () => {
    const cache = createEvidenceBodyCache();
    for (let index = 0; index < 128; index++) cache.set(body(index));

    const replacement: EvidenceResponse = { ...body(0), text: "replacement", bytes: 11 };
    cache.set(replacement);

    expect(cache.size).toBe(128);
    expect(cache.get(replacement.id)).toEqual(replacement);
    for (let index = 1; index < 128; index++) {
      expect(cache.get(body(index).id)).toEqual(body(index));
    }
  });

  it("touches recency on get so a hot body survives the next insertion", () => {
    const cache = createEvidenceBodyCache();
    for (let index = 0; index < 128; index++) cache.set(body(index));

    expect(cache.get(body(0).id)).toEqual(body(0));
    cache.set(body(128));

    expect(cache.size).toBe(128);
    expect(cache.get(body(1).id)).toBeUndefined();
    expect(cache.get(body(0).id)).toEqual(body(0));
    for (let index = 2; index <= 128; index++) {
      expect(cache.get(body(index).id)).toEqual(body(index));
    }
  });

  it("counts input and output responses toward one total 128-body budget", () => {
    const cache = createEvidenceBodyCache();
    for (let index = 0; index < 65; index++) {
      for (const part of ["input", "output"] as const) {
        cache.set(body(index, part));
        expect(cache.size).toBeLessThanOrEqual(128);
        expect(cache.size).toBe(Math.min(index * 2 + (part === "input" ? 1 : 2), 128));
      }
    }

    expect(cache.size).toBe(128);
    for (const part of ["input", "output"] as const) {
      expect(cache.get(body(0, part).id)).toBeUndefined();
      for (let index = 1; index < 65; index++) {
        expect(cache.get(body(index, part).id)).toEqual(body(index, part));
      }
    }
  });

  it("clears every retained body and allows reuse without stale reads", () => {
    const cache = createEvidenceBodyCache();
    for (let index = 0; index < 128; index++) cache.set(body(index));

    cache.clear();

    expect(cache.size).toBe(0);
    for (let index = 0; index < 128; index++) {
      expect(cache.get(body(index).id)).toBeUndefined();
    }
    cache.set(body(128));
    expect(cache.size).toBe(1);
    expect(cache.get(body(128).id)).toEqual(body(128));
    expect(cache.get(body(0).id)).toBeUndefined();
  });

  it("keeps bodies local to each cache instance", () => {
    const first = createEvidenceBodyCache();
    const second = createEvidenceBodyCache();
    first.set(body(0));

    expect(second.size).toBe(0);
    expect(second.get(body(0).id)).toBeUndefined();
    second.set(body(1));
    first.clear();
    expect(first.size).toBe(0);
    expect(second.size).toBe(1);
    expect(second.get(body(1).id)).toEqual(body(1));
  });
});
