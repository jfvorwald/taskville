import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVICTED_MESSAGE,
  type EvidenceStore,
  MAX_BODY_BYTES,
  openEvidenceStore,
  TRUNCATION_MARKER,
} from "../../src/evidence/index.ts";
import type { EvidenceSink } from "../../src/sources/claude-code/index.ts";
import { fakeGithubToken } from "../ingest/helpers.ts";

let dir = "";
let path = "";
const open: EvidenceStore[] = [];

function store(options: Parameters<typeof openEvidenceStore>[1] = {}): EvidenceStore {
  const s = openEvidenceStore(path, options);
  open.push(s);
  return s;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "taskville-evidence-"));
  path = join(dir, "evidence.db");
});
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Every byte SQLite has written: the database and its WAL and SHM files. */
function fileBytes(): string {
  return ["", "-wal", "-shm"]
    .map((suffix) => `${path}${suffix}`)
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p).toString("latin1"))
    .join("");
}

describe("openEvidenceStore", () => {
  it("creates evidence.db owner-only, in WAL mode", () => {
    const s = store();
    s.store("p", [{ toolCallId: "t1", input: { a: 1 } }]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${path}${suffix}`))
        expect(statSync(`${path}${suffix}`).mode & 0o777).toBe(0o600);
    }
    expect(s.journalMode()).toBe("wal");
  });

  it("refuses a symlinked database file", () => {
    symlinkSync(join(dir, "elsewhere.db"), path);
    expect(() => openEvidenceStore(path)).toThrow();
  });

  it("refuses a cap that is not a positive whole number of bytes", () => {
    for (const capBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => openEvidenceStore(path, { capBytes })).toThrow(RangeError);
    }
  });

  it("keeps bodies across a reopen", () => {
    store().store("p", [{ toolCallId: "t1", output: "hello" }]);
    for (const s of open.splice(0)) s.close();
    expect(store().get("p", "t1")?.output).toMatchObject({ status: "stored", text: "hello" });
  });
});

describe("EvidenceStore as the Claude Code EvidenceSink", () => {
  it("implements the sink interface", () => {
    const sink: EvidenceSink = store();
    sink.store("p", [{ toolCallId: "t1", input: { command: "ls" }, output: { stdout: "a" } }]);
    expect(store().get("p", "t1")).toMatchObject({
      toolCallId: "t1",
      input: { status: "stored", text: '{"command":"ls"}', truncated: false },
      output: { status: "stored", text: '{"stdout":"a"}', truncated: false },
    });
  });

  it("stores a string body as the string itself", () => {
    const s = store();
    s.store("p", [{ toolCallId: "t1", output: "line 1\nline 2" }]);
    expect(s.get("p", "t1")?.output).toMatchObject({ text: "line 1\nline 2" });
  });

  it("answers undefined for an unknown tool call, and null for a part never sent", () => {
    const s = store();
    s.store("p", [{ toolCallId: "t1", input: { a: 1 } }]);
    expect(s.get("p", "nope")).toBeUndefined();
    expect(s.get("other", "t1")).toBeUndefined();
    expect(s.get("p", "t1")?.output).toBeNull();
  });

  it("keeps the first body for a tool call part, like the event log's first write", () => {
    const s = store();
    s.store("p", [{ toolCallId: "t1", output: "first" }]);
    s.store("p", [{ toolCallId: "t1", output: "second" }]);
    expect(s.get("p", "t1")?.output).toMatchObject({ text: "first" });
  });

  it("skips tool call IDs that are not usable IDs and stores the rest", () => {
    const s = store();
    s.store("p", [
      { toolCallId: "", output: "x" },
      { toolCallId: "y".repeat(201), output: "x" },
      { toolCallId: "bad\uD800", output: "x" },
      { toolCallId: fakeGithubToken(3), output: "x" },
      { toolCallId: 7 as unknown as string, output: "x" },
      { toolCallId: "ok", output: "x" },
    ]);
    expect(s.get("p", "ok")?.output).toMatchObject({ text: "x" });
    for (const id of ["", "y".repeat(201), "bad\uD800", fakeGithubToken(3)]) {
      expect(s.get("p", id)).toBeUndefined();
    }
  });

  it("does not throw on a body it cannot serialize, and stores the other parts", () => {
    const s = store();
    let deep: unknown = "leaf";
    for (let i = 0; i < 200_000; i++) deep = [deep];
    expect(() =>
      s.store("p", [
        { toolCallId: "t1", input: 10n as unknown, output: "kept" },
        { toolCallId: "t2", input: deep },
      ]),
    ).not.toThrow();
    expect(s.get("p", "t1")?.output).toMatchObject({ text: "kept" });
    expect(s.get("p", "t1")?.input).toBeNull();
  });
});

describe("redaction before any write", () => {
  it("masks a secret in a nested value and in a string body, and never writes it to disk", () => {
    const secret = fakeGithubToken(11);
    const s = store();
    s.store("p", [
      {
        toolCallId: "t1",
        input: {
          command: `curl -H "Authorization: Bearer ${secret}" x`,
          env: { password: "hunter2-pass" },
        },
        output: `token=${secret}\n`,
      },
    ]);
    const call = s.get("p", "t1");
    const input = call?.input?.status === "stored" ? call.input : undefined;
    const output = call?.output?.status === "stored" ? call.output : undefined;
    expect(input?.text).not.toContain(secret);
    expect(input?.text).not.toContain("hunter2-pass");
    expect(input?.masked).toBe(true);
    expect(output?.text).not.toContain(secret);
    expect(output?.masked).toBe(true);
    // The bytes on disk, before and after a checkpoint.
    expect(fileBytes()).not.toContain(secret);
    expect(fileBytes()).not.toContain("hunter2-pass");
    for (const o of open.splice(0)) o.close();
    expect(fileBytes()).not.toContain(secret);
  });

  it("masks everything nested under a sensitive key, whatever its type (roborev 5142)", () => {
    const s = store();
    s.store("p", [
      {
        toolCallId: "t1",
        input: {
          password: { value: "nested-pw-1" },
          apiKey: ["a", { k: "nested-k-2" }],
          token: 123456789,
          credentials: { user: "u", pass: "nested-pw-3" },
          ok: { plain: "visible" },
        },
      },
    ]);
    const body = s.get("p", "t1")?.input;
    if (body?.status !== "stored") throw new Error("not stored");
    for (const secret of ["nested-pw-1", "nested-k-2", "123456789", "nested-pw-3"]) {
      expect(body.text).not.toContain(secret);
      expect(fileBytes()).not.toContain(secret);
    }
    expect(body.text).toContain("visible");
    expect(body.masked).toBe(true);
  });

  it("keys bodies by the hash of the stored, redacted bytes, so raw bytes are not derivable", () => {
    const secret = fakeGithubToken(12);
    const s = store();
    s.store("p", [{ toolCallId: "t1", output: `key ${secret}` }]);
    const body = s.get("p", "t1")?.output;
    expect(body?.status).toBe("stored");
    if (body?.status !== "stored") return;
    expect(body.hash).toBe(sha256(body.text));
    expect(body.hash).not.toBe(sha256(`key ${secret}`));
    expect(body.hash).not.toBe(sha256(JSON.stringify(`key ${secret}`)));
  });

  it("stores a lone surrogate as well-formed text and hashes what it stored", () => {
    const s = store();
    s.store("p", [{ toolCallId: "t1", output: "a\uD800b" }]);
    const body = s.get("p", "t1")?.output;
    if (body?.status !== "stored") throw new Error("not stored");
    expect(body.text.isWellFormed()).toBe(true);
    expect(body.hash).toBe(sha256(body.text));
  });

  it("treats a __proto__ key as data (L-18)", () => {
    const s = store();
    const input = JSON.parse('{"__proto__": {"password": "polluted-pass"}, "a": 1}') as unknown;
    s.store("p", [{ toolCallId: "t1", input }]);
    const body = s.get("p", "t1")?.input;
    if (body?.status !== "stored") throw new Error("not stored");
    expect(body.text).toContain('"__proto__"');
    expect(body.text).not.toContain("polluted-pass");
    expect(({} as Record<string, unknown>).password).toBeUndefined();
  });
});

describe("64 KB cap per body", () => {
  it("cuts a body over 64 KB after masking and ends it with the truncation marker", () => {
    const s = store();
    const big = "x".repeat(MAX_BODY_BYTES * 2);
    s.store("p", [{ toolCallId: "t1", output: big }]);
    const body = s.get("p", "t1")?.output;
    if (body?.status !== "stored") throw new Error("not stored");
    expect(body.truncated).toBe(true);
    expect(body.bytes).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(Buffer.byteLength(body.text, "utf8")).toBe(body.bytes);
    expect(body.text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(body.text.startsWith("xxxx")).toBe(true);
    expect(body.hash).toBe(sha256(body.text));
  });

  it("keeps a body of exactly 64 KB whole", () => {
    const s = store();
    s.store("p", [{ toolCallId: "t1", output: "x".repeat(MAX_BODY_BYTES) }]);
    const body = s.get("p", "t1")?.output;
    if (body?.status !== "stored") throw new Error("not stored");
    expect(body.truncated).toBe(false);
    expect(body.bytes).toBe(MAX_BODY_BYTES);
  });

  it("never splits a multi-byte character or a surrogate pair at the cut", () => {
    const s = store();
    s.store("p", [{ toolCallId: "t1", output: "\u{1F600}".repeat(MAX_BODY_BYTES) }]);
    const body = s.get("p", "t1")?.output;
    if (body?.status !== "stored") throw new Error("not stored");
    expect(body.text.isWellFormed()).toBe(true);
    expect(body.text.replace(TRUNCATION_MARKER, "")).toMatch(/^(\u{1F600})+$/u);
    expect(body.bytes).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });

  it("masks before cutting, so a secret past the cut is masked and one at the cut never leaks", () => {
    const secret = fakeGithubToken(13);
    const s = store();
    // The secret straddles the 64 KB boundary: cutting first would keep its first half unmasked.
    const before = "y".repeat(MAX_BODY_BYTES - TRUNCATION_MARKER.length - 10);
    s.store("p", [{ toolCallId: "t1", output: `${before} ${secret} ${"z".repeat(1000)}` }]);
    const body = s.get("p", "t1")?.output;
    if (body?.status !== "stored") throw new Error("not stored");
    expect(body.text).not.toContain(secret.slice(0, 9));
    expect(fileBytes()).not.toContain(secret.slice(0, 12));
  });

  it("masks a long private key block whole even when it is far past 64 KB (no pre-cut)", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      ...Array.from(
        { length: 3000 },
        () => "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
      ),
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const s = store();
    s.store("p", [{ toolCallId: "t1", output: `${pem}\nafter` }]);
    const body = s.get("p", "t1")?.output;
    if (body?.status !== "stored") throw new Error("not stored");
    expect(body.text).not.toContain(
      "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
    );
    expect(body.text).toContain("after");
  });
});

describe("per-project cap with oldest-first eviction", () => {
  const body = (n: number) => `${String(n).padStart(4, "0")}${"b".repeat(996)}`; // 1,000 bytes

  it("evicts the oldest bodies of the project until it is under its cap", () => {
    const s = store({ capBytes: 3_500 });
    for (let i = 1; i <= 5; i++) s.store("p", [{ toolCallId: `t${i}`, output: body(i) }]);
    expect(s.stats("p")).toEqual({ bodies: 3, bytes: 3_000 });
    for (const i of [1, 2]) {
      expect(s.get("p", `t${i}`)?.output).toEqual({
        status: "evicted",
        hash: sha256(body(i)),
        message: EVICTED_MESSAGE,
      });
    }
    for (const i of [3, 4, 5]) {
      expect(s.get("p", `t${i}`)?.output).toMatchObject({ status: "stored", text: body(i) });
    }
    expect(EVICTED_MESSAGE).toBe("details no longer stored");
  });

  it("counts each project separately", () => {
    const s = store({ capBytes: 2_500 });
    for (let i = 1; i <= 2; i++) s.store("a", [{ toolCallId: `t${i}`, output: body(i) }]);
    for (let i = 1; i <= 2; i++) s.store("b", [{ toolCallId: `t${i}`, output: body(i + 10) }]);
    expect(s.stats("a")).toEqual({ bodies: 2, bytes: 2_000 });
    expect(s.stats("b")).toEqual({ bodies: 2, bytes: 2_000 });
    s.store("a", [{ toolCallId: "t3", output: body(3) }]);
    expect(s.get("a", "t1")?.output?.status).toBe("evicted");
    expect(s.get("b", "t1")?.output?.status).toBe("stored");
  });

  it("stores identical content once per project and refreshes its age when referenced again", () => {
    const s = store({ capBytes: 2_500 });
    s.store("p", [{ toolCallId: "t1", output: body(1) }]);
    s.store("p", [{ toolCallId: "t2", output: body(2) }]);
    // t3 has the same content as t1: one body, now the newest.
    s.store("p", [{ toolCallId: "t3", output: body(1) }]);
    expect(s.stats("p")).toEqual({ bodies: 2, bytes: 2_000 });
    s.store("p", [{ toolCallId: "t4", output: body(4) }]);
    expect(s.get("p", "t2")?.output?.status).toBe("evicted");
    expect(s.get("p", "t1")?.output?.status).toBe("stored");
    expect(s.get("p", "t3")?.output?.status).toBe("stored");
  });

  it("never evicts the body it just wrote, even when that body alone is over the cap", () => {
    const s = store({ capBytes: 500 });
    s.store("p", [{ toolCallId: "t1", output: body(1) }]);
    s.store("p", [{ toolCallId: "t2", output: body(2) }]);
    expect(s.get("p", "t1")?.output?.status).toBe("evicted");
    expect(s.get("p", "t2")?.output?.status).toBe("stored");
  });

  it("keeps tool call pointers after eviction and serves a body again if its content returns", () => {
    const s = store({ capBytes: 1_500 });
    s.store("p", [{ toolCallId: "t1", output: body(1) }]);
    s.store("p", [{ toolCallId: "t2", output: body(2) }]);
    expect(s.get("p", "t1")?.output?.status).toBe("evicted");
    s.store("p", [{ toolCallId: "t3", output: body(1) }]);
    expect(s.get("p", "t1")?.output?.status).toBe("stored");
  });

  it("defaults the cap to 1 GB", () => {
    expect(store().capBytes).toBe(1024 ** 3);
  });

  it("deletes a project's bodies and pointers with one call", () => {
    const s = store();
    s.store("a", [{ toolCallId: "t1", output: "a" }]);
    s.store("b", [{ toolCallId: "t1", output: "b" }]);
    s.deleteProject("a");
    expect(s.get("a", "t1")).toBeUndefined();
    expect(s.stats("a")).toEqual({ bodies: 0, bytes: 0 });
    expect(s.get("b", "t1")?.output).toMatchObject({ text: "b" });
  });
});
