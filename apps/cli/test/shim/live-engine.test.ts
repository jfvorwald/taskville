// M7.30 (#434, M7.06 finding L1): the hook shim and the OTel headers helper hand the CLI token
// (and, for the shim, the unredacted hook payload) only to a live engine recorded in
// `$TASKVILLE_HOME/engine.json` (`{ url, pid, startedAt, keyListener }`, written by `serve`).
// Contract: post only when engine.json exists, its url equals the target origin and its pid is
// alive; otherwise spool without contacting the port. The helper prints nothing and exits 0 in
// the same cases, so the token is not handed out. The stand-in engine records every curl request,
// so "not contacted" means `server.received` stays empty.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Home,
  hookPayload,
  makeHome,
  runShim,
  SHELLS,
  shimEnv,
  spoolLines,
  startServer,
  TOKEN,
} from "./harness.ts";

const HELPER = join(import.meta.dirname, "..", "..", "hooks", "claude-code-otel-headers.sh");

/** A pid that was alive a moment ago and is not now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (child.pid === undefined) throw new Error("could not spawn a child");
  return child.pid;
}

/** Writes engine.json the way `serve` does (apps/cli/src/commands/serve.ts writeRuntimeInfo). */
function writeEngineJson(home: Home, url: string, pid: number): void {
  const info = { url, pid, startedAt: new Date().toISOString(), keyListener: false };
  writeFileSync(join(home.home, "engine.json"), `${JSON.stringify(info)}\n`, { mode: 0o600 });
}

describe.each(SHELLS)("claude-code-shim.sh posts only to a live engine under %s", (shell) => {
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

  async function hook() {
    const payload = hookPayload(7);
    const run = await runShim({
      shell,
      input: JSON.stringify(payload),
      env: shimEnv(home, server.url),
    });
    expect(run).toMatchObject({ code: 0, stdout: "" });
    return payload;
  }

  function expectSpooledNotPosted(payload: unknown) {
    expect(server.received).toHaveLength(0);
    const lines = spoolLines(home);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.payload).toEqual(payload);
  }

  it("posts, and does not spool, when engine.json matches the target and its pid is alive", async () => {
    writeEngineJson(home, server.url, process.pid);
    const payload = await hook();
    expect(server.received).toHaveLength(1);
    expect(server.received[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(server.received[0]?.body ?? "")).toMatchObject({ payload });
    expect(spoolLines(home)).toHaveLength(0);
  });

  it("spools without contacting the port when engine.json is missing", async () => {
    expectSpooledNotPosted(await hook());
  });

  it("spools without contacting the port when engine.json names a dead pid (stale)", async () => {
    writeEngineJson(home, server.url, deadPid());
    expectSpooledNotPosted(await hook());
  });

  it("spools without contacting the port when engine.json points at a different port", async () => {
    const other = await startServer();
    try {
      writeEngineJson(home, other.url, process.pid);
      expectSpooledNotPosted(await hook());
      expect(other.received).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it("spools without contacting the port when engine.json points at a different host", async () => {
    writeEngineJson(home, `http://localhost:${server.port}`, process.pid);
    expectSpooledNotPosted(await hook());
  });

  it("spools without contacting the port when engine.json is not valid JSON", async () => {
    writeFileSync(join(home.home, "engine.json"), "not json", { mode: 0o600 });
    expectSpooledNotPosted(await hook());
  });
});

describe.each(SHELLS)(
  "claude-code-otel-headers.sh hands out the token only for a live engine under %s",
  (shell) => {
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

    function helper() {
      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TASKVILLE_HOME: home.home,
        TASKVILLE_URL: server.url,
      };
      const run = spawnSync(shell, [HELPER], { env, encoding: "utf8" });
      return { code: run.status, stdout: run.stdout };
    }

    it("prints the header when engine.json matches the target and its pid is alive", () => {
      writeEngineJson(home, server.url, process.pid);
      expect(helper()).toEqual({ code: 0, stdout: `{"Authorization":"Bearer ${TOKEN}"}\n` });
    });

    it("prints nothing and exits 0 when engine.json is missing", () => {
      expect(helper()).toEqual({ code: 0, stdout: "" });
    });

    it("prints nothing and exits 0 when engine.json names a dead pid", () => {
      writeEngineJson(home, server.url, deadPid());
      expect(helper()).toEqual({ code: 0, stdout: "" });
    });

    it("prints nothing and exits 0 when engine.json points at a different port", () => {
      writeEngineJson(home, `http://127.0.0.1:${server.port + 1}`, process.pid);
      expect(helper()).toEqual({ code: 0, stdout: "" });
    });
  },
);
