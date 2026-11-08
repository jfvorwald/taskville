// M7.30 (#434, M7.06 finding L1): the hook shim and the OTel headers helper hand the CLI token
// (and, for the shim, the unredacted hook payload) only to a live engine recorded in
// `$TASKVILLE_HOME/engine.json` (`{ url, pid, startedAt, keyListener }`, written by `serve`).
// Contract: post only when engine.json exists, its url equals the target origin and its pid is
// alive; otherwise spool without contacting the port. The helper prints nothing and exits 0 in
// the same cases, so the token is not handed out. The stand-in engine records every curl request,
// so "not contacted" means `server.received` stays empty.

import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
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

/** Writes engine.json with a raw body, for records `serve` would never write. */
function writeRawEngineJson(home: Home, body: string): void {
  writeFileSync(join(home.home, "engine.json"), body, { mode: 0o600 });
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

  async function hook(target: string = server.url) {
    const payload = hookPayload(7);
    const run = await runShim({
      shell,
      input: JSON.stringify(payload),
      env: shimEnv(home, target),
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

  // Canonical equality: `localhost` on either side equals 127.0.0.1 (serve always records
  // 127.0.0.1, installs may hold localhost). Port, other hosts and scheme must still match.
  it("posts when the target is localhost and engine.json records 127.0.0.1 on the same port", async () => {
    writeEngineJson(home, `http://127.0.0.1:${server.port}`, process.pid);
    const payload = await hook(`http://localhost:${server.port}`);
    expect(server.received).toHaveLength(1);
    expect(JSON.parse(server.received[0]?.body ?? "")).toMatchObject({ payload });
    expect(spoolLines(home)).toHaveLength(0);
  });

  it("posts when the target is 127.0.0.1 and engine.json records localhost on the same port", async () => {
    writeEngineJson(home, `http://localhost:${server.port}`, process.pid);
    await hook(`http://127.0.0.1:${server.port}`);
    expect(server.received).toHaveLength(1);
    expect(spoolLines(home)).toHaveLength(0);
  });

  it("spools when localhost is on a different port than engine.json", async () => {
    writeEngineJson(home, `http://127.0.0.1:${server.port + 1}`, process.pid);
    expectSpooledNotPosted(await hook(`http://localhost:${server.port}`));
  });

  it("spools without contacting the port when engine.json points at a different host", async () => {
    writeEngineJson(home, `http://127.0.0.2:${server.port}`, process.pid);
    expectSpooledNotPosted(await hook());
  });

  it("spools without contacting the port when engine.json uses a different scheme", async () => {
    writeEngineJson(home, `https://127.0.0.1:${server.port}`, process.pid);
    expectSpooledNotPosted(await hook());
  });

  it("posts when TASKVILLE_URL has a trailing slash", async () => {
    writeEngineJson(home, server.url, process.pid);
    await hook(`${server.url}/`);
    expect(server.received).toHaveLength(1);
    expect(spoolLines(home)).toHaveLength(0);
  });

  it("spools when engine.json names a pid longer than 7 digits (4294967296)", async () => {
    writeEngineJson(home, server.url, 4294967296);
    expectSpooledNotPosted(await hook());
  });

  it("spools when engine.json names pid 0", async () => {
    writeEngineJson(home, server.url, 0);
    expectSpooledNotPosted(await hook());
  });

  it("spools when engine.json names a pid with trailing junk (5x)", async () => {
    writeRawEngineJson(home, `{"url":"${server.url}","pid":${process.pid}x,"keyListener":false}\n`);
    expectSpooledNotPosted(await hook());
  });

  it("spools when engine.json is a symlink to a valid record", async () => {
    writeFileSync(
      join(home.home, "real-engine.json"),
      `${JSON.stringify({ url: server.url, pid: process.pid })}\n`,
    );
    symlinkSync(join(home.home, "real-engine.json"), join(home.home, "engine.json"));
    expectSpooledNotPosted(await hook());
  });

  it("spools when engine.json is a directory", async () => {
    mkdirSync(join(home.home, "engine.json"));
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

    function helper(target: string = server.url) {
      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TASKVILLE_HOME: home.home,
        TASKVILLE_URL: target,
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

    const HEADER = { code: 0, stdout: `{"Authorization":"Bearer ${TOKEN}"}\n` };
    const NOTHING = { code: 0, stdout: "" };

    it("prints the header when the target is localhost and engine.json records 127.0.0.1", () => {
      writeEngineJson(home, `http://127.0.0.1:${server.port}`, process.pid);
      expect(helper(`http://localhost:${server.port}`)).toEqual(HEADER);
    });

    it("prints the header when the target is 127.0.0.1 and engine.json records localhost", () => {
      writeEngineJson(home, `http://localhost:${server.port}`, process.pid);
      expect(helper(`http://127.0.0.1:${server.port}`)).toEqual(HEADER);
    });

    it("prints nothing for localhost on a different port than engine.json", () => {
      writeEngineJson(home, `http://127.0.0.1:${server.port + 1}`, process.pid);
      expect(helper(`http://localhost:${server.port}`)).toEqual(NOTHING);
    });

    it("prints nothing for a different host (127.0.0.2) or scheme", () => {
      writeEngineJson(home, `http://127.0.0.2:${server.port}`, process.pid);
      expect(helper()).toEqual(NOTHING);
      writeEngineJson(home, `https://127.0.0.1:${server.port}`, process.pid);
      expect(helper()).toEqual(NOTHING);
    });

    it("prints the header when TASKVILLE_URL has a trailing slash", () => {
      writeEngineJson(home, server.url, process.pid);
      expect(helper(`${server.url}/`)).toEqual(HEADER);
    });

    it("prints nothing for a pid longer than 7 digits (4294967296) or pid 0", () => {
      writeEngineJson(home, server.url, 4294967296);
      expect(helper()).toEqual(NOTHING);
      writeEngineJson(home, server.url, 0);
      expect(helper()).toEqual(NOTHING);
    });

    it("prints nothing for a pid with trailing junk (5x)", () => {
      writeRawEngineJson(home, `{"url":"${server.url}","pid":${process.pid}x,"keyListener":false}\n`);
      expect(helper()).toEqual(NOTHING);
    });

    it("prints nothing and exits 0 when engine.json is malformed JSON", () => {
      writeRawEngineJson(home, "not json");
      expect(helper()).toEqual(NOTHING);
      writeRawEngineJson(home, `{"url":"${server.url}","pid":`);
      expect(helper()).toEqual(NOTHING);
    });

    it("prints nothing when engine.json is a symlink or a directory", () => {
      writeFileSync(
        join(home.home, "real-engine.json"),
        `${JSON.stringify({ url: server.url, pid: process.pid })}\n`,
      );
      symlinkSync(join(home.home, "real-engine.json"), join(home.home, "engine.json"));
      expect(helper()).toEqual(NOTHING);
    });

    it("prints nothing when engine.json is a directory", () => {
      mkdirSync(join(home.home, "engine.json"));
      expect(helper()).toEqual(NOTHING);
    });
  },
);
