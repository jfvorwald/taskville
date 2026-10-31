// M2.01: the Claude Code telemetry hook shim (apps/cli/hooks/claude-code-shim.sh).
// Every test spawns the real script under a POSIX shell.

import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deadUrl,
  type Home,
  hookPayload,
  makeHome,
  runShim,
  SHELLS,
  shimEnv,
  spoolFiles,
  spoolLines,
  startServer,
  TOKEN,
  UTC_SECONDS,
  UUID,
} from "./harness.ts";

const CAP = 1024 * 1024;
const exec = promisify(execFile);

describe.each(SHELLS)("claude-code-shim.sh under %s", (shell) => {
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

  it("posts { payload, sourceEventId } with the CLI token and writes no spool", async () => {
    const payload = hookPayload(1);
    const run = await runShim({
      shell,
      input: JSON.stringify(payload),
      env: shimEnv(home, server.url),
    });

    expect(run).toMatchObject({ code: 0, stdout: "" });
    expect(server.received).toHaveLength(1);
    const [req] = server.received;
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe("/v1/sources/claude-code/hooks");
    expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req?.headers["content-type"]).toBe("application/json");
    expect(req?.headers.host).toBe(`127.0.0.1:${server.port}`);
    // A bearer POST needs no Origin (http-api.md check 3); a non-browser client sends none.
    expect(req?.headers.origin).toBeUndefined();
    const body = JSON.parse(req?.body ?? "") as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["payload", "sourceEventId"]);
    expect(body.payload).toEqual(payload);
    expect(body.sourceEventId).toMatch(UUID);
    expect(spoolFiles(home).size).toBe(0);
  });

  it("joins a pretty-printed payload onto one line without changing its value", async () => {
    const payload = hookPayload(2);
    const input = JSON.stringify(payload, null, 2).replace(/\n/g, "\r\n");
    await runShim({ shell, input, env: shimEnv(home, server.url) });
    const body = JSON.parse(server.received[0]?.body ?? "") as { payload: unknown };
    expect(body.payload).toEqual(payload);
  });

  it("gives every invocation a fresh UUID v4", async () => {
    for (let i = 0; i < 3; i++) {
      await runShim({
        shell,
        input: JSON.stringify(hookPayload(i)),
        env: shimEnv(home, server.url),
      });
    }
    const ids = server.received.map(
      (r) => (JSON.parse(r.body) as { sourceEventId: string }).sourceEventId,
    );
    for (const id of ids) expect(id).toMatch(UUID);
    expect(new Set(ids).size).toBe(3);
  });

  it("falls back to /dev/urandom when uuidgen fails", async () => {
    const stubs = join(home.root, "stubs");
    mkdirSync(stubs);
    writeFileSync(join(stubs, "uuidgen"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const env = shimEnv(home, server.url, {
      PATH: `${stubs}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    });
    await runShim({ shell, input: JSON.stringify(hookPayload(3)), env });
    const body = JSON.parse(server.received[0]?.body ?? "") as { sourceEventId: string };
    expect(body.sourceEventId).toMatch(UUID);
  });

  it("appends one line to the spool when the engine is down", async () => {
    const payload = hookPayload(4);
    const run = await runShim({
      shell,
      input: JSON.stringify(payload),
      env: shimEnv(home, await deadUrl()),
    });

    expect(run).toMatchObject({ code: 0, stdout: "" });
    const lines = spoolLines(home);
    expect([...spoolFiles(home).keys()]).toEqual(["claude-code.jsonl"]);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(Object.keys(line ?? {})).toEqual(["payload", "sourceEventId", "spooledAt"]);
    expect(line?.payload).toEqual(payload);
    expect(line?.sourceEventId).toMatch(UUID);
    expect(line?.spooledAt).toMatch(UTC_SECONDS);
    expect(Math.abs(Date.parse(line?.spooledAt ?? "") - Date.now())).toBeLessThan(60_000);
  });

  it("creates the spool file 0600 in a 0700 spool directory", async () => {
    rmSync(home.spoolDir, { recursive: true });
    await runShim({
      shell,
      input: JSON.stringify(hookPayload(5)),
      env: shimEnv(home, await deadUrl()),
    });
    expect(statSync(home.spoolDir).mode & 0o777).toBe(0o700);
    expect(statSync(home.spoolFile).mode & 0o777).toBe(0o600);
  });

  it("spools on a non-2xx answer", async () => {
    for (const status of [401, 403, 500, 302]) {
      server.setMode({ kind: "status", status });
      await runShim({
        shell,
        input: JSON.stringify(hookPayload(status)),
        env: shimEnv(home, server.url),
      });
    }
    expect(server.received).toHaveLength(4);
    const lines = spoolLines(home);
    expect(lines.map((l) => (l.payload as { tool_use_id: string }).tool_use_id)).toEqual([
      "toolu_401",
      "toolu_403",
      "toolu_500",
      "toolu_302",
    ]);
    // The spooled ID is the one that was posted, so a replay deduplicates.
    const posted = server.received.map(
      (r) => (JSON.parse(r.body) as { sourceEventId: string }).sourceEventId,
    );
    expect(lines.map((l) => l.sourceEventId)).toEqual(posted);
  });

  it("stays bounded and spools when the engine hangs", async () => {
    server.setMode({ kind: "hang" });
    const run = await runShim({
      shell,
      input: JSON.stringify(hookPayload(6)),
      env: shimEnv(home, server.url),
    });
    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(3000);
    expect(spoolLines(home)).toHaveLength(1);
  });

  it("spools without posting when there is no token yet", async () => {
    rmSync(join(home.home, "token"));
    const run = await runShim({
      shell,
      input: JSON.stringify(hookPayload(7)),
      env: shimEnv(home, server.url),
    });
    expect(run.code).toBe(0);
    expect(server.received).toHaveLength(0);
    expect(spoolLines(home)).toHaveLength(1);
  });

  it("never sends the token to a URL that is not the loopback engine root", async () => {
    for (const url of [
      `${server.url}/elsewhere`,
      `https://127.0.0.1:${server.port}`,
      `http://user@127.0.0.1:${server.port}`,
    ]) {
      await runShim({ shell, input: JSON.stringify(hookPayload(8)), env: shimEnv(home, url) });
    }
    expect(server.received).toHaveLength(0);
    expect(spoolLines(home)).toHaveLength(3);
  });

  it("ignores proxy settings so the token stays on loopback", async () => {
    const proxy = await startServer();
    try {
      const env = shimEnv(home, server.url, {
        http_proxy: proxy.url,
        HTTP_PROXY: proxy.url,
        ALL_PROXY: proxy.url,
        all_proxy: proxy.url,
      });
      await runShim({ shell, input: JSON.stringify(hookPayload(9)), env });
      expect(proxy.received).toHaveLength(0);
      expect(server.received).toHaveLength(1);
    } finally {
      await proxy.close();
    }
  });

  it("does not read the user's .curlrc", async () => {
    // A .curlrc that would print to stdout and send a second header.
    writeFileSync(
      join(home.root, ".curlrc"),
      'verbose\nheader = "X-From-Curlrc: 1"\nwrite-out = "CURLRC"\n',
    );
    const run = await runShim({
      shell,
      input: JSON.stringify(hookPayload(10)),
      env: shimEnv(home, server.url),
    });
    expect(run.stdout).toBe("");
    expect(server.received[0]?.headers["x-from-curlrc"]).toBeUndefined();
  });

  it("keeps the token out of the process list", async () => {
    server.setMode({ kind: "hang" });
    let shimPid = 0;
    const running = runShim({
      shell,
      input: JSON.stringify(hookPayload(11)),
      env: shimEnv(home, server.url),
      onSpawn: (pid) => {
        shimPid = pid;
      },
    });
    // Wait until the request is in flight, so curl is running.
    for (let i = 0; i < 100 && server.received.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(server.received).toHaveLength(1);
    const { stdout } = await exec("ps", ["-ww", "-A", "-o", "pid=,ppid=,args="]);
    const children = stdout
      .split("\n")
      .filter((row) => row.trim().split(/\s+/)[1] === String(shimPid));
    expect(children.some((row) => row.includes("curl"))).toBe(true);
    expect(stdout).not.toContain(TOKEN);
    await running;
  });

  it("does nothing for empty input", async () => {
    const run = await runShim({ shell, input: " \n", env: shimEnv(home, await deadUrl()) });
    expect(run).toMatchObject({ code: 0, stdout: "" });
    expect(spoolFiles(home).size).toBe(0);
  });

  it("replaces an oversized payload with a marker, posted and spooled alike", async () => {
    const big = JSON.stringify({ ...hookPayload(12), tool_response: { stdout: "y".repeat(CAP) } });
    await runShim({ shell, input: big, env: shimEnv(home, server.url) });
    const body = JSON.parse(server.received[0]?.body ?? "") as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["payload", "payloadBytesAtLeast", "sourceEventId"]);
    expect(body.payload).toBeNull();
    expect(body.payloadBytesAtLeast).toBeGreaterThan(CAP);
    expect(body.payloadBytesAtLeast).toBeLessThanOrEqual(big.length);

    const run = await runShim({ shell, input: big, env: shimEnv(home, await deadUrl()) });
    expect(run.code).toBe(0);
    const [line] = spoolLines(home);
    expect(line?.payload).toBeNull();
    expect(line?.payloadBytesAtLeast).toBeGreaterThan(CAP);
    expect(statSync(home.spoolFile).size).toBeLessThan(1024);
  });

  it("keeps a payload of exactly the cap", async () => {
    const base = JSON.stringify({ ...hookPayload(13), tool_response: { stdout: "" } });
    const exact = base.replace('"stdout":""', `"stdout":"${"z".repeat(CAP - base.length)}"`);
    expect(Buffer.byteLength(exact)).toBe(CAP);
    await runShim({ shell, input: exact, env: shimEnv(home, await deadUrl()) });
    const [line] = spoolLines(home);
    expect(JSON.stringify(line?.payload)).toBe(exact);
  });

  it("refuses to follow a symlinked spool file and keeps the event in its own file", async () => {
    const target = join(home.root, "elsewhere.txt");
    writeFileSync(target, "untouched\n");
    symlinkSync(target, home.spoolFile);
    const run = await runShim({
      shell,
      input: JSON.stringify(hookPayload(14)),
      env: shimEnv(home, await deadUrl()),
    });
    expect(run.code).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("untouched\n");
    expect(lstatSync(home.spoolFile).isSymbolicLink()).toBe(true);
    const own = readdirSync(home.spoolDir).filter((n) =>
      /^claude-code\.[0-9a-f-]{36}\.jsonl$/.test(n),
    );
    expect(own).toHaveLength(1);
  });

  it("writes nothing when the spool directory is a symlink", async () => {
    const target = join(home.root, "other-dir");
    mkdirSync(target);
    rmSync(home.spoolDir, { recursive: true });
    symlinkSync(target, home.spoolDir);
    const run = await runShim({
      shell,
      input: JSON.stringify(hookPayload(15)),
      env: shimEnv(home, await deadUrl()),
    });
    expect(run.code).toBe(0);
    expect(readdirSync(target)).toEqual([]);
  });

  it("starts a fresh line after a torn last line", async () => {
    writeFileSync(home.spoolFile, '{"payload":{"torn', { mode: 0o600 });
    await runShim({
      shell,
      input: JSON.stringify(hookPayload(16)),
      env: shimEnv(home, await deadUrl()),
    });
    const text = readFileSync(home.spoolFile, "utf8");
    const rows = text.split("\n");
    expect(rows[0]).toBe('{"payload":{"torn');
    expect(
      (JSON.parse(rows[1] ?? "") as { payload: { tool_use_id: string } }).payload.tool_use_id,
    ).toBe("toolu_16");
  });

  it("breaks a lock left by a dead process", async () => {
    const lock = join(home.spoolDir, "claude-code.lock");
    mkdirSync(lock, { mode: 0o700 });
    // A PID that is not running: a child that has already exited.
    const dead = (await exec("sh", ["-c", "sh -c 'echo $$'"])).stdout.trim();
    writeFileSync(join(lock, "pid"), `${dead}\n`);
    const run = await runShim({
      shell,
      input: JSON.stringify(hookPayload(17)),
      env: shimEnv(home, await deadUrl()),
    });
    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(3000);
    expect([...spoolFiles(home).keys()]).toEqual(["claude-code.jsonl"]);
    expect(spoolLines(home)).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });

  it("never waits long on a live lock: the event goes to its own file", async () => {
    const lock = join(home.spoolDir, "claude-code.lock");
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "pid"), `${process.pid}\n`);
    const run = await runShim({
      shell,
      input: JSON.stringify(hookPayload(18)),
      env: shimEnv(home, await deadUrl()),
    });
    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(3000);
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(home.spoolFile)).toBe(false);
    const lines = spoolLines(home);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.payload).toMatchObject({ tool_use_id: "toolu_18" });
  });

  it("exits 0 even when the home cannot be written", async () => {
    rmSync(home.spoolDir, { recursive: true, force: true });
    chmodSync(home.home, 0o500);
    const run = await runShim({
      shell,
      input: JSON.stringify(hookPayload(19)),
      env: shimEnv(home, await deadUrl()),
    });
    chmodSync(home.home, 0o700);
    expect(run).toMatchObject({ code: 0, stdout: "" });
  });

  it("exits 0 with no HOME and no TASKVILLE_HOME", async () => {
    const run = await runShim({
      shell,
      input: JSON.stringify(hookPayload(20)),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    expect(run).toMatchObject({ code: 0, stdout: "" });
  });

  it("uses ~/.taskville when TASKVILLE_HOME is unset, and expands a leading ~", async () => {
    const env = shimEnv(home, await deadUrl());
    const { TASKVILLE_HOME: _unset, ...withoutHome } = env;
    await runShim({ shell, input: JSON.stringify(hookPayload(21)), env: withoutHome });
    expect(existsSync(join(home.root, ".taskville", "spool", "claude-code.jsonl"))).toBe(true);
    await runShim({
      shell,
      input: JSON.stringify(hookPayload(22)),
      env: { ...env, TASKVILLE_HOME: "~/tilde-home" },
    });
    expect(existsSync(join(home.root, "tilde-home", "spool", "claude-code.jsonl"))).toBe(true);
  });

  it("does not corrupt the spool under concurrent invocations", async () => {
    const url = await deadUrl();
    const count = 24;
    // 150 KB each: larger than a pipe buffer, so unlocked appends would interleave.
    const payloads = Array.from({ length: count }, (_, i) => hookPayload(100 + i, 150_000));
    const runs = await Promise.all(
      payloads.map((payload) =>
        runShim({ shell, input: JSON.stringify(payload), env: shimEnv(home, url) }),
      ),
    );
    for (const run of runs) expect(run).toMatchObject({ code: 0, stdout: "" });
    const lines = spoolLines(home);
    expect(lines).toHaveLength(count);
    const byId = new Map(
      lines.map((l) => [(l.payload as { tool_use_id: string }).tool_use_id, l.payload]),
    );
    for (const payload of payloads)
      expect(byId.get(payload.tool_use_id as string)).toEqual(payload);
    expect(new Set(lines.map((l) => l.sourceEventId)).size).toBe(count);
    // No lock or temporary file is left behind.
    expect(readdirSync(home.spoolDir).filter((n) => !n.endsWith(".jsonl"))).toEqual([]);
  }, 30_000);
});
