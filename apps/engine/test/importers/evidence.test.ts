import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, openEvidenceStore } from "../../src/evidence/index.ts";
import { fakeGithubToken } from "../ingest/helpers.ts";
import { commitEvent, fakeImporter, makeJobs, PROJECT, useImportsEnv } from "./helpers.ts";

// Evidence from an import goes through the evidence store: redacted, bounded, never raw.

const env = useImportsEnv();

describe("import evidence", () => {
  it("stores tool bodies redacted and bounded through the evidence store", async () => {
    const store = openEvidenceStore(join(env().dir, "evidence.db"), { now: () => new Date() });
    try {
      const token = fakeGithubToken();
      const huge = "x".repeat(MAX_BODY_BYTES * 2);
      const importer = fakeImporter(
        [
          {
            events: [commitEvent("a", "2026-11-01T10:00:00Z")],
            evidence: [
              { toolCallId: "tc-secret", input: { command: `curl -H "Authorization: ${token}"` } },
              { toolCallId: "tc-big", output: huge },
            ],
          },
        ],
        { kind: "transcripts" },
      );
      const jobs = makeJobs(env(), [importer], { evidence: store });
      const { importId } = jobs.start({
        projectId: PROJECT,
        kind: "transcripts",
        root: env().root,
      });
      const finished = await jobs.settled(importId);
      expect(finished.status).toBe("done");

      const secret = store.get(PROJECT, "tc-secret");
      expect(secret?.input?.status).toBe("stored");
      if (secret?.input?.status === "stored") {
        expect(secret.input.text).not.toContain(token);
        expect(secret.input.masked).toBe(true);
      }

      const big = store.get(PROJECT, "tc-big");
      expect(big?.output?.status).toBe("stored");
      if (big?.output?.status === "stored") {
        expect(big.output.truncated).toBe(true);
        expect(big.output.bytes).toBeLessThanOrEqual(MAX_BODY_BYTES);
      }

      // The archive's events never carry the raw bodies.
      const events = env().storage.archives().events(importId, 1, 100);
      expect(JSON.stringify(events)).not.toContain(token);
    } finally {
      store.close();
    }
  });
});
