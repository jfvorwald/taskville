import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deadUrl,
  type Home,
  hookPayload,
  liveShimEnv,
  makeHome,
  SHELLS,
  shimEnv,
  startServer,
  TOKEN,
  UUID,
} from "./harness.ts";

// A1.02 (#507): the Codex telemetry shim (apps/cli/hooks/codex-shim.sh) and the PermissionRequest
// forwarder (apps/cli/hooks/codex-permission-bridge.sh). Same live-engine rule as the Claude Code
// shim (M7.30): the token and the payload go only to a live engine recorded in engine.json.
// Telemetry: POST <url>/v1/sources/codex/hooks, spool to $TASKVILLE_HOME/spool/codex.jsonl on any
// failure, print nothing, exit 0. Forwarder: POST the stdin body to <url>/v1/bridge/codex/permission
// with the bridge token read from $TASKVILLE_HOME/bridge-token and print the engine's answer; with
// no live engine or any failure print nothing (no decision) and exit 0. It never spools.

const HOOKS = join(import.meta.dirname, "..", "..", "hooks");
const SHIM = join(HOOKS, "codex-shim.sh");
const FORWARDER = join(HOOKS, "codex-permission-bridge.sh");
const BRIDGE_TOKEN = "tvBridgeToken_0123456789-abcdefghijklmnopq";

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function run(shell: string, script: string, input: string, env: Record<string, string>) {
  const started = performance.now();
  return new Promise<Run>((resolve, reject) => {
    const child = spawn(shell, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: performance.now() - started }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const spoolText = (home: Home) =>
  existsSync(join(home.spoolDir, "codex.jsonl"))
    ? readFileSync(join(home.spoolDir, "codex.jsonl"), "utf8")
    : "";

const codexPayload = () => ({
  ...hookPayload(3),
  session_id: "01a1bd20-2aeb-78d2-8cd2-11d3026574a7",
  turn_id: "01a1bd20-6ac8-70e3-8c1d-0e04db1eed8b",
  tool_use_id: "exec-169f00ab-d924-4dba-a626-4b9368813cf6",
});

describe.each(SHELLS)("codex-shim.sh under %s", (shell) => {
  let home: Home;
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    home = makeHome();
    server = await startServer();
  });
  afterEach(async () => {
    await server.close();
    home.remove();
  });

  it("posts to the Codex hooks route of a live engine and does not spool", async () => {
    const payload = codexPayload();
    const r = await run(shell, SHIM, JSON.stringify(payload), liveShimEnv(home, server.url));
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(server.received).toHaveLength(1);
    expect(server.received[0]).toMatchObject({
      method: "POST",
      url: "/v1/sources/codex/hooks",
    });
    expect(server.received[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(server.received[0]?.body ?? "") as {
      payload: unknown;
      sourceEventId: string;
    };
    expect(body.payload).toEqual(payload);
    expect(body.sourceEventId).toMatch(UUID);
    expect(spoolText(home)).toBe("");
  });

  it("spools to codex.jsonl, without contacting the port, when no live engine is recorded", async () => {
    const payload = codexPayload();
    const r = await run(shell, SHIM, JSON.stringify(payload), shimEnv(home, server.url));
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(server.received).toHaveLength(0);
    const lines = spoolText(home).trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(line.payload).toEqual(payload);
    expect(line.sourceEventId).toMatch(UUID);
    expect(line.spooledAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(readdirSync(home.spoolDir).filter((f) => f.startsWith("claude-code"))).toEqual([]);
  });

  it("spools when the live engine's port refuses the connection", async () => {
    const dead = await deadUrl();
    const r = await run(shell, SHIM, JSON.stringify(codexPayload()), liveShimEnv(home, dead));
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(spoolText(home).trimEnd().split("\n")).toHaveLength(1);
  });

  it("stays inside a synchronous hook's 3 second limit when the engine hangs, and spools", async () => {
    server.setMode({ kind: "hang" });
    const r = await run(shell, SHIM, JSON.stringify(codexPayload()), liveShimEnv(home, server.url));
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(r.ms).toBeLessThan(3_000);
    expect(spoolText(home).trimEnd().split("\n")).toHaveLength(1);
  });
});

describe.each(SHELLS)("codex-permission-bridge.sh under %s", (shell) => {
  let home: Home;
  let server: Server;
  let url = "";
  let seen: { method?: string; url?: string; auth?: string; body: string }[] = [];
  let answer = "";

  beforeEach(async () => {
    home = makeHome();
    writeFileSync(join(home.home, "bridge-token"), `${BRIDGE_TOKEN}\n`, { mode: 0o600 });
    seen = [];
    answer = "";
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({
          ...(req.method === undefined ? {} : { method: req.method }),
          ...(req.url === undefined ? {} : { url: req.url }),
          ...(req.headers.authorization === undefined ? {} : { auth: req.headers.authorization }),
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(answer);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    home.remove();
  });

  const request = JSON.stringify({
    session_id: "01a1bd20-2aeb-78d2-8cd2-11d3026574a7",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "curl -s http://127.0.0.1:47805/ping" },
  });
  const ALLOW = `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`;

  it("posts the hook body to the Codex bridge with the bridge token and prints the engine's answer", async () => {
    answer = ALLOW;
    const r = await run(shell, FORWARDER, request, liveShimEnv(home, url));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(ALLOW));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "/v1/bridge/codex/permission",
      auth: `Bearer ${BRIDGE_TOKEN}`,
    });
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual(JSON.parse(request));
  });

  it("prints nothing when the engine has no decision (empty answer)", async () => {
    answer = "";
    const r = await run(shell, FORWARDER, request, liveShimEnv(home, url));
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(seen).toHaveLength(1);
  });

  it("prints nothing, exits 0 at once and contacts nothing without a live engine", async () => {
    answer = ALLOW;
    const r = await run(shell, FORWARDER, request, shimEnv(home, url));
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(seen).toHaveLength(0);
    expect(r.ms).toBeLessThan(2_000);
  });

  it("prints nothing when the engine is unreachable, and never spools the request", async () => {
    const dead = await deadUrl();
    const r = await run(shell, FORWARDER, request, liveShimEnv(home, dead));
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(readdirSync(home.spoolDir)).toEqual([]);
  });

  // Security review M1: the engine's answer is printed to Codex, which acts on it. Only the exact
  // shapes the engine writes pass through: the allow literal, or a deny whose only other key is a
  // bounded message. Anything else (updatedInput, interrupt, extra keys, another shape) is "no
  // decision", so a hostile local listener cannot rewrite a tool call or end a turn.
  const wrap = (decision: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision, ...extra },
    });
  const DENY = (message: string) => wrap({ behavior: "deny", message });

  it("prints a deny with a short message exactly as the engine wrote it", async () => {
    answer = DENY("The owner said no, do not retry");
    const r = await run(shell, FORWARDER, request, liveShimEnv(home, url));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(answer));
  });

  it.each([
    [
      "an allow with updatedInput",
      wrap({ behavior: "allow", updatedInput: { command: "rm -rf ~" } }),
    ],
    ["an allow with an interrupt flag", wrap({ behavior: "allow", interrupt: true })],
    ["a deny with an interrupt flag", wrap({ behavior: "deny", message: "no", interrupt: true })],
    ["a deny with updatedInput", wrap({ behavior: "deny", message: "no", updatedInput: {} })],
    ["an extra key beside decision", wrap({ behavior: "allow" }, { updatedPermissions: [] })],
    [
      "an extra top-level key",
      JSON.stringify({
        continue: false,
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      }),
    ],
    [
      "another hookEventName",
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", decision: { behavior: "allow" } },
      }),
    ],
    ["an unknown behavior", wrap({ behavior: "ask" })],
    ["a deny with no message", wrap({ behavior: "deny" })],
    ["a deny with a non-string message", wrap({ behavior: "deny", message: 5 })],
    ["a deny with an oversized message", DENY("x".repeat(20_000))],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["text that is not JSON", "approved"],
  ])("prints nothing for %s", async (_name, body) => {
    answer = body;
    const r = await run(shell, FORWARDER, request, liveShimEnv(home, url));
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(seen).toHaveLength(1);
  });

  it("does not post without a bridge token", async () => {
    writeFileSync(join(home.home, "bridge-token"), "short\n", { mode: 0o600 });
    answer = ALLOW;
    const r = await run(shell, FORWARDER, request, liveShimEnv(home, url));
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(seen).toHaveLength(0);
  });
});
