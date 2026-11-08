import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assistantText,
  assistantToolUse,
  SESSION,
  T,
  toolResult,
  userPrompt,
} from "../../../../packages/adapters/test/claude-code/transcripts/fixtures.ts";
import {
  CLI_MAIN,
  freePort,
  runShim,
  token,
  within,
} from "../../../../tests/e2e/claude-code-telemetry/harness.ts";
import { evidenceId } from "../../src/feed/evidence.ts";

// M8.11 (issue #478): the importers are wired into a real `taskville serve --headless`, and an
// archive's tool call bodies are readable over HTTP, apart from live evidence.
//
// A real engine child process runs against a temporary TASKVILLE_HOME, HOME and CLAUDE_CONFIG_DIR
// (the real ~/.claude, ~/.codex and ~/.taskville are never touched). Archive evidence contract:
//   GET /v1/evidence/:id?archive=<archiveId>   (:id is the live route's evidence ID)
// Same credentials and body shape as the live read; never resolves a live body for an archive
// request, nor an archive body for a live one.

const PROJECT = "demo";
const LIVE_AND_ARCHIVE_CALL = "toolu_BASH";
const ARCHIVE_ONLY_CALL = "toolu_ONLY";
const ARCHIVE_MARKER = "archive-output-marker";
const LIVE_MARKER = "live-output-marker";

let tmp = "";
let home = "";
let root = "";
let url = "";
let child: ChildProcess | undefined;
let stderr = "";

const auth = () => ({ Authorization: `Bearer ${token(home)}` });

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}${path}`, { headers: auth() });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: keep the text.
  }
  return { status: res.status, body };
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: tmp,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: "2026-10-01T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-10-01T10:00:00Z",
    },
  });
};

/** Branches and a merge: main (a, c), feature (b), then `merge feature` into main. */
function makeFixtureRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "b.txt"), "b\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "feature work");
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "c.txt"), "c\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "main work");
  git(dir, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
}

function makeTranscript(configDir: string, repoRoot: string): void {
  const dir = join(configDir, "projects", repoRoot.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const at = (n: number) => ({ ts: T(n), cwd: repoRoot });
  const lines = [
    userPrompt("Run the checks and read the notes", at(0)),
    assistantToolUse(
      LIVE_AND_ARCHIVE_CALL,
      "Bash",
      { command: "pnpm test", description: "Run tests" },
      at(1),
    ),
    toolResult(LIVE_AND_ARCHIVE_CALL, ARCHIVE_MARKER, at(2)),
    assistantToolUse(ARCHIVE_ONLY_CALL, "Read", { file_path: `${repoRoot}/notes.txt` }, at(3)),
    toolResult(ARCHIVE_ONLY_CALL, `${ARCHIVE_MARKER}-only`, at(4)),
    assistantText("All done", at(5), "end_turn"),
  ];
  writeFileSync(
    join(dir, `${SESSION}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
}

async function startImport(kind: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}/v1/imports`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: PROJECT, kind, root }),
  });
  return { status: res.status, body: await res.json() };
}

async function importToDone(kind: string): Promise<string> {
  const started = await startImport(kind);
  expect(started.body).toMatchObject({ status: "running" });
  expect(started.status).toBe(202);
  const archiveId = String(started.body.archiveId);
  let last: any;
  const settled = await within(
    30_000,
    async () => {
      last = (await get(`/v1/imports/${archiveId}`)).body;
      return last?.status !== "running";
    },
    100,
  );
  expect(settled, `import did not finish: ${JSON.stringify(last)}`).toBeDefined();
  expect(last).toMatchObject({ status: "done", kind });
  return archiveId;
}

async function archiveEvents(archiveId: string): Promise<any[]> {
  const res = await get(`/v1/timelines/archive:${archiveId}/events?limit=1000`);
  expect(res.status).toBe(200);
  return res.body.events;
}

async function expectReplays(archiveId: string): Promise<void> {
  const list = await get(`/v1/projects/${PROJECT}/timelines`);
  expect(list.status).toBe(200);
  const entry = list.body.timelines.find((t: any) => t.id === `archive:${archiveId}`);
  expect(entry).toMatchObject({ kind: "archive", projectId: PROJECT });
  expect(entry.eventCount).toBeGreaterThan(0);
  const state = await get(`/v1/timelines/archive:${archiveId}/state?at=${entry.eventCount}`);
  expect(state.status).toBe(200);
  expect(state.body).toMatchObject({ at: entry.eventCount, attention: [] });
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "taskville-m811-")));
  home = join(tmp, "tv-home");
  root = join(tmp, "work", "repo");
  const configDir = join(tmp, "claude-config");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(configDir, { recursive: true });
  makeFixtureRepo(root);
  makeTranscript(configDir, root);
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ projects: [{ id: PROJECT, name: "Demo", roots: [root] }] }),
  );
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    [CLI_MAIN, "serve", "--headless", "--home", home, "--port", String(port)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: tmp,
        TASKVILLE_HOME: home,
        CLAUDE_CONFIG_DIR: configDir,
      },
    },
  );
  child.stderr?.on("data", (c: Buffer) => {
    stderr += c.toString("utf8");
  });
  let out = "";
  const started = await new Promise<boolean>((done) => {
    const timer = setTimeout(() => done(false), 20_000);
    child?.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      if (out.includes("#pair=")) {
        clearTimeout(timer);
        done(true);
      }
    });
    child?.once("exit", () => done(false));
  });
  if (!started) throw new Error(`engine did not start:\n${out}\n${stderr}`);
}, 60_000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child?.once("exit", r));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  }
  if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
});

describe("importers wired into serve (M8.11)", () => {
  it("imports a git repository into an archive that lists, replays and shows commits", async () => {
    const archiveId = await importToDone("git");
    await expectReplays(archiveId);
    const events = await archiveEvents(archiveId);
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "git.commit").length).toBeGreaterThanOrEqual(4);
    expect(types).toContain("git.merge");
  }, 60_000);

  it("imports transcripts into an archive that lists, replays and shows tool calls", async () => {
    const archiveId = await importToDone("transcripts");
    await expectReplays(archiveId);
    const events = await archiveEvents(archiveId);
    const finished = events.filter((e) => e.type === "tool_call.finished");
    expect(finished.map((e) => e.payload.toolCallId)).toContain(LIVE_AND_ARCHIVE_CALL);
  }, 60_000);

  describe("archive evidence over HTTP", () => {
    let archiveId = "";
    const evidenceUrl = (callId: string, archive?: string) =>
      `/v1/evidence/${evidenceId(PROJECT, callId, "output")}${
        archive === undefined ? "" : `?archive=${encodeURIComponent(archive)}`
      }`;

    beforeAll(async () => {
      // A live body for the same tool call ID, through the real shim, before the import.
      const hook = (extra: Record<string, unknown>) =>
        JSON.stringify({
          session_id: "live-session-1",
          cwd: root,
          transcript_path: join(tmp, "unused.jsonl"),
          ...extra,
        });
      await runShim(hook({ hook_event_name: "SessionStart", source: "startup" }), home, url);
      await runShim(
        hook({
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "echo live" },
          tool_response: { stdout: LIVE_MARKER, stderr: "", interrupted: false },
          tool_use_id: LIVE_AND_ARCHIVE_CALL,
        }),
        home,
        url,
      );
      const live = await within(
        10_000,
        async () => (await get(evidenceUrl(LIVE_AND_ARCHIVE_CALL))).status === 200,
      );
      expect(live, `live evidence never arrived\n${stderr.slice(-2000)}`).toBeDefined();
      archiveId = await importToDone("transcripts");
    }, 60_000);

    it("reads the imported body with the archive parameter", async () => {
      const res = await get(evidenceUrl(ARCHIVE_ONLY_CALL, archiveId));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        projectId: PROJECT,
        toolCallId: ARCHIVE_ONLY_CALL,
        part: "output",
      });
      expect(res.body.text).toContain(`${ARCHIVE_MARKER}-only`);
      expect(Array.isArray(res.body.masks)).toBe(true);
    });

    it("answers 404 without the archive parameter when no live body exists", async () => {
      const res = await get(evidenceUrl(ARCHIVE_ONLY_CALL));
      expect(res.status).toBe(404);
    });

    it("never returns a live body for an archive request, nor the reverse", async () => {
      const archived = await get(evidenceUrl(LIVE_AND_ARCHIVE_CALL, archiveId));
      expect(archived.status).toBe(200);
      expect(archived.body.text).toContain(ARCHIVE_MARKER);
      expect(archived.body.text).not.toContain(LIVE_MARKER);
      const live = await get(evidenceUrl(LIVE_AND_ARCHIVE_CALL));
      expect(live.status).toBe(200);
      expect(live.body.text).toContain(LIVE_MARKER);
      expect(live.body.text).not.toContain(ARCHIVE_MARKER);
    });

    it("answers 404 for an archive that does not hold the body", async () => {
      const res = await get(evidenceUrl(ARCHIVE_ONLY_CALL, "00000000-0000-4000-8000-000000000000"));
      expect(res.status).toBe(404);
    });

    it("needs the same credentials as the live read", async () => {
      const res = await fetch(`${url}${evidenceUrl(ARCHIVE_ONLY_CALL, archiveId)}`);
      expect(res.status).toBe(401);
    });
  });
});
