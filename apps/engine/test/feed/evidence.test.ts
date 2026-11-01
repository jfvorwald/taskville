import { describe, expect, it } from "vitest";
import { EVICTED_MESSAGE, MAX_BODY_BYTES, TRUNCATION_MARKER } from "../../src/evidence/index.ts";
import { fakeGithubToken } from "../ingest/helpers.ts";
import {
  type EvidenceResponse,
  evidenceIdsOf,
  leadOf,
  runBash,
  SPIKE_CWD,
  toolCallFrames,
  useHarness,
} from "./helpers.ts";

// M5.01: GET /v1/evidence/:id. M2.06 already built the evidence store (redacted, 64 KB bodies,
// per-project cap with eviction, ToolCall pointers that outlive eviction) and the Claude Code
// source fills it; nothing served those bodies until now. Evidence IDs are opaque strings handed
// out by feed frames; they are URL-encoded in the path and carry their project, so an ID
// resolves in one project only.
//
// Pinned 200 body: { id, projectId, toolCallId, part: "input" | "output", text, masks, truncated,
// bytes }. `text` is the stored (already redacted) body as plain text: a JSON string, never HTML
// and never HTML-escaped (the web client escapes at render time, ARCHITECTURE.md section 12), so
// `<b>` comes back as `<b>`. `masks` locates each mask marker in `text` by UTF-16 offsets,
// `[start, end)`, sorted, with the mask kind, so the viewer can offer click-to-reveal.
// Errors: 404 unknown_evidence, 410 evidence_evicted (message says "details no longer stored").

const start = useHarness();
const SESSION = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const CALL = "toolu_evidence00000000000001";

async function oneCall(
  h: Awaited<ReturnType<ReturnType<typeof useHarness>>>,
  stdout: string,
  command = "echo hello",
) {
  h.addProject("spike", SPIKE_CWD);
  await runBash(h, { session: SESSION, toolUseId: CALL, command, stdout, label: "ev" });
  return evidenceIdsOf(h, leadOf(SESSION), CALL);
}

async function fetchBody(
  h: Awaited<ReturnType<ReturnType<typeof useHarness>>>,
  id: string,
): Promise<EvidenceResponse> {
  const res = await h.evidenceBody(id);
  expect(res.status).toBe(200);
  return (await res.json()) as EvidenceResponse;
}

describe("GET /v1/evidence/:id", () => {
  it("returns a stored tool input and output as plain text, JSON, never HTML", async () => {
    const h = await start();
    const ids = await oneCall(h, "hello\n", "echo hello");

    const res = await h.evidenceBody(ids.output);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const output = (await res.json()) as EvidenceResponse;
    expect(output).toMatchObject({
      id: ids.output,
      projectId: "spike",
      toolCallId: CALL,
      part: "output",
      text: expect.stringContaining("hello"),
      masks: [],
      truncated: false,
      bytes: Buffer.byteLength(output.text, "utf8"),
    });

    const input = await fetchBody(h, ids.input);
    expect(input.part).toBe("input");
    expect(input.toolCallId).toBe(CALL);
    expect(input.text).toContain("echo hello");
    expect(input.id).not.toBe(output.id);
  });

  it("returns markup as it was recorded, not as HTML and not HTML-escaped", async () => {
    const h = await start();
    // No quotes or backslashes: the body is stored as compact JSON, which would escape those.
    const hostile = "<img src=x onerror=alert(1)> & <script>steal()</script>";
    const ids = await oneCall(h, hostile);
    const body = await fetchBody(h, ids.output);
    expect(body.text).toContain(hostile);
    expect(body.text).not.toContain("&lt;");
  });

  it("gives the mask spans of redacted values and never the value itself", async () => {
    const h = await start();
    const secret = fakeGithubToken(11);
    const ids = await oneCall(h, `token is ${secret} ok`);

    const res = await h.evidenceBody(ids.output);
    const raw = await res.text();
    expect(raw).not.toContain(secret);
    const body = JSON.parse(raw) as EvidenceResponse;
    expect(body.text).toContain("[REDACTED:github-token]");
    expect(body.masks).toHaveLength(1);
    const [mask] = body.masks;
    expect(mask?.kind).toBe("github-token");
    expect(body.text.slice(mask?.start, mask?.end)).toBe("[REDACTED:github-token]");
  });

  it("reports a body cut at 64 KB as truncated, ending with the truncation marker", async () => {
    const h = await start();
    const ids = await oneCall(h, "an ordinary line of output\n".repeat(4000));
    const body = await fetchBody(h, ids.output);
    expect(body.truncated).toBe(true);
    expect(body.text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(body.bytes).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(body.bytes).toBe(Buffer.byteLength(body.text, "utf8"));
  });

  it("answers 404 unknown_evidence for an ID that was never handed out", async () => {
    const h = await start();
    await oneCall(h, "x");
    for (const id of ["no-such-evidence", "a".repeat(500), "../../health", "%00"]) {
      const res = await h.evidenceBody(id);
      expect(res.status, id.slice(0, 20)).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "unknown_evidence", message: expect.any(String) },
      });
    }
  });

  it("keeps two projects' evidence apart even when their tool call IDs are the same", async () => {
    const h = await start();
    h.addProject("alpha", "/work/alpha");
    h.addProject("bravo", "/work/bravo");
    // The same session and tool_use_id reach two projects (the cwd moved between hooks).
    await runBash(h, {
      session: SESSION,
      toolUseId: CALL,
      command: "echo a",
      stdout: "alpha-output",
      cwd: "/work/alpha",
      label: "a",
    });
    await runBash(h, {
      session: SESSION,
      toolUseId: CALL,
      command: "echo b",
      stdout: "bravo-output",
      cwd: "/work/bravo",
      label: "b",
    });

    const a = await evidenceIdsOf(h, leadOf(SESSION), CALL, "?projectId=alpha");
    const b = await evidenceIdsOf(h, leadOf(SESSION), CALL, "?projectId=bravo");
    expect(a.output).not.toBe(b.output);
    const alpha = await fetchBody(h, a.output);
    const bravo = await fetchBody(h, b.output);
    expect(alpha.projectId).toBe("alpha");
    expect(alpha.text).toContain("alpha-output");
    expect(alpha.text).not.toContain("bravo-output");
    expect(bravo.projectId).toBe("bravo");
    expect(bravo.text).toContain("bravo-output");
    expect(bravo.text).not.toContain("alpha-output");
  });
});

describe("evidence eviction", () => {
  const filler = (lines: number) => "an ordinary line of output\n".repeat(lines);

  it("tells the viewer the details are gone (410 evidence_evicted) while the ToolCall still shows in the feed", async () => {
    // A 3,000 byte cap: the second call's output pushes the first call's bodies out (oldest first).
    const h = await start({ capBytes: 3000 });
    h.addProject("spike", SPIKE_CWD);
    const first = "toolu_evict0000000000000001";
    const second = "toolu_evict0000000000000002";
    await runBash(h, {
      session: SESSION,
      toolUseId: first,
      command: "echo one",
      stdout: filler(55),
      label: "e1",
    });
    await runBash(h, {
      session: SESSION,
      toolUseId: second,
      command: "echo two",
      stdout: filler(80),
      label: "e2",
    });

    const reader = await h.openFeed(leadOf(SESSION));
    const frames = await toolCallFrames(reader, 4);
    await reader.cancel();
    // The calls are all still there, in order; only what their bodies said is gone.
    expect(frames.map((f) => [f.data.toolCallId, f.data.phase])).toEqual([
      [first, "running"],
      [first, "succeeded"],
      [second, "running"],
      [second, "succeeded"],
    ]);
    const [oneRunning, oneDone, twoRunning, twoDone] = frames.map((f) => f.data);
    expect(oneRunning?.evidence.input?.status).toBe("evicted");
    expect(oneDone?.evidence.input?.status).toBe("evicted");
    expect(oneDone?.evidence.output?.status).toBe("evicted");
    expect(twoRunning?.evidence.input?.status).toBe("stored");
    expect(twoDone?.evidence.output?.status).toBe("stored");

    const gone = await h.evidenceBody(oneDone?.evidence.output?.id ?? "");
    expect(gone.status).toBe(410);
    const error = (await gone.json()) as { error: { code: string; message: string } };
    expect(error.error.code).toBe("evidence_evicted");
    expect(error.error.message).toContain(EVICTED_MESSAGE);
    expect(JSON.stringify(error)).not.toContain("an ordinary line");

    const goneInput = await h.evidenceBody(oneDone?.evidence.input?.id ?? "");
    expect(goneInput.status).toBe(410);

    const kept = await h.evidenceBody(twoDone?.evidence.output?.id ?? "");
    expect(kept.status).toBe(200);
    expect(((await kept.json()) as EvidenceResponse).text).toContain("an ordinary line");
  });
});
