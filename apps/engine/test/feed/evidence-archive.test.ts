import { describe, expect, it } from "vitest";
import { evidenceId } from "../../src/feed/evidence.ts";
import { BRIDGE_TOKEN, bearer, CLI_TOKEN, ORIGIN, sessionHeaders } from "../http/helpers.ts";
import { type EvidenceResponse, useHarness } from "./helpers.ts";

// M8.11 security review: archive-scoped evidence reads, `GET /v1/evidence/:id?archive=<archiveId>`.
//   - Without `archive`, only the live scope is read: an evidence ID whose project ID carries the
//     archive scope separator (U+0001 "archive" U+0001 <archive id>) must not reach an archive.
//   - A project ID that fails the project ID pattern (^[a-z0-9][a-z0-9-]{0,62}$) is never resolved.
//   - An archive of one project is never read through another project's evidence ID.
//   - The archive parameter is a lowercase canonical UUID; anything else is 404 unknown_evidence.
//   - The read scope applies as for live evidence: bridge token 403, paired browser session 200.

const start = useHarness();
const ARCHIVE_A = "abcdef12-abcd-4abc-8abc-abcdefabcdef";
const CALL = "toolu_archive000000000001";
const SEPARATOR = "\u0001archive\u0001";

type H = Awaited<ReturnType<ReturnType<typeof useHarness>>>;

function seedArchive(h: H, projectId: string, archiveId: string, output = "archived body"): void {
  h.evidence.store(projectId, [{ toolCallId: CALL, output }], archiveId);
}

const read = (h: H, id: string, archive?: string, headers?: Record<string, string>) =>
  h.get(
    `/v1/evidence/${encodeURIComponent(id)}${
      archive === undefined ? "" : `?archive=${encodeURIComponent(archive)}`
    }`,
    headers,
  );

const expectUnknown = async (res: Response, label: string) => {
  expect(res.status, label).toBe(404);
  expect(await res.json(), label).toMatchObject({ error: { code: "unknown_evidence" } });
};

describe("evidence id validation", () => {
  it("does not reach an archive scope through a project ID that carries the separator", async () => {
    const h = await start();
    seedArchive(h, "spike", ARCHIVE_A);
    // Sanity: the archive body is readable the intended way.
    const intended = await read(h, evidenceId("spike", CALL, "output"), ARCHIVE_A);
    expect(intended.status).toBe(200);
    // The crafted ID names the archive scope key directly, with no ?archive=.
    const crafted = evidenceId(`spike${SEPARATOR}${ARCHIVE_A}`, CALL, "output");
    await expectUnknown(await read(h, crafted), "crafted id, no archive parameter");
    await expectUnknown(await read(h, crafted, ARCHIVE_A), "crafted id with an archive parameter");
  });

  it("answers 404 for any project ID that fails the project ID pattern", async () => {
    const h = await start();
    const bad = [
      "Spike",
      "spike_one",
      "-spike",
      "spike ",
      "a".repeat(64),
      "",
      `spike${SEPARATOR}${ARCHIVE_A}`,
      "spike\u0000",
    ];
    for (const projectId of bad) {
      // A live body stored under the odd project ID, so only validation can refuse it.
      h.evidence.store(projectId, [{ toolCallId: CALL, output: "live body" }]);
      await expectUnknown(
        await read(h, evidenceId(projectId, CALL, "output")),
        JSON.stringify(projectId),
      );
    }
  });

  it("does not read another project's archive through this project's evidence ID", async () => {
    const h = await start();
    seedArchive(h, "project-a", ARCHIVE_A, "a's archived body");
    const ok = await read(h, evidenceId("project-a", CALL, "output"), ARCHIVE_A);
    expect(ok.status).toBe(200);
    const crossed = await read(h, evidenceId("project-b", CALL, "output"), ARCHIVE_A);
    await expectUnknown(crossed, "project B id, archive of project A");
  });

  it("answers 404 for a malformed archive ID", async () => {
    const h = await start();
    const id = evidenceId("spike", CALL, "output");
    seedArchive(h, "spike", ARCHIVE_A.toUpperCase());
    for (const archive of [
      ARCHIVE_A.toUpperCase(),
      "",
      "..",
      "../../etc/passwd",
      "..%2f..%2fhealth",
      `${ARCHIVE_A}/..`,
      `${ARCHIVE_A}${SEPARATOR}x`,
      `${ARCHIVE_A} `,
      "not-a-uuid",
      "1".repeat(300),
    ]) {
      await expectUnknown(await read(h, id, archive), JSON.stringify(archive));
    }
  });
});

describe("archive evidence read access", () => {
  it("refuses the bridge token on an archive evidence read (403)", async () => {
    const h = await start();
    seedArchive(h, "spike", ARCHIVE_A);
    const res = await read(h, evidenceId("spike", CALL, "output"), ARCHIVE_A, bearer(BRIDGE_TOKEN));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("archived body");
  });

  it("lets a paired browser session read archive evidence (200)", async () => {
    const h = await start();
    seedArchive(h, "spike", ARCHIVE_A);
    const session = h.pairing.exchange(h.pairing.issueCode()) ?? "";
    const res = await read(h, evidenceId("spike", CALL, "output"), ARCHIVE_A, {
      ...sessionHeaders(session),
      Origin: ORIGIN,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EvidenceResponse;
    expect(body).toMatchObject({ projectId: "spike", toolCallId: CALL, part: "output" });
    expect(body.text).toContain("archived body");
  });

  it("still answers the CLI token", async () => {
    const h = await start();
    seedArchive(h, "spike", ARCHIVE_A);
    const res = await read(h, evidenceId("spike", CALL, "output"), ARCHIVE_A, bearer(CLI_TOKEN));
    expect(res.status).toBe(200);
  });
});
