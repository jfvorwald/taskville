import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDefaultExecFile,
  defaultExecFile,
  defaultIsDirectory,
  openSession,
} from "../../src/commands/open-session.ts";

// Review-fix contract pinned for M4.08, on top of the 8 tests in open-session.test.ts (unchanged):
//
//   createDefaultExecFile({ graceMs? }) => OpenSessionExecFile   (graceMs defaults to 2000)
//   defaultExecFile = createDefaultExecFile()
//     Launch semantics, not exit semantics: spawn with shell:false and ignored stdio (nothing is
//     buffered, so a chatty opener is never killed). Resolve once the child has started and is
//     still alive after graceMs (the child is left running, not killed). If it exits 0 inside the
//     grace window, resolve. If it exits non-zero, or fails to spawn, inside the window, reject
//     with an error carrying `code` (exit code number, or "ENOENT"), so openSession reports
//     { status: "failed", reason: "spawn-failed" } with the code in the message.
//
//   defaultIsDirectory(path) => Promise<boolean>   (real fs.stat; false for files and missing paths)
//   OpenSessionDeps gains an OPTIONAL `isDirectory?: (path: string) => Promise<boolean>`.
//     When supplied and it resolves false, openSession returns { status: "failed",
//     reason: "invalid-value" } and runs nothing. When omitted, no directory check is made: the
//     existing tests use the fake cwd /Users/dev/repo (absent on this machine) with a fake
//     execFile, so a mandatory real check would break them. The production wiring (M4.03) must
//     pass `isDirectory: defaultIsDirectory`.

const NASTY_NAME = "; $(whoami) `id` | & > \"' *";
const GRACE_MS = 200;

let root: string;
let scriptsDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "open-session-exec-"));
  scriptsDir = join(root, "scripts");
  await mkdir(scriptsDir);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeScript(name: string, body: string): Promise<string> {
  const path = join(scriptsDir, name);
  await writeFile(path, body);
  return path;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return exists(path);
}

describe("defaultExecFile: argument passing with the real default", () => {
  it("hands a cwd full of shell metacharacters to the program as one literal argument", async () => {
    const cwd = join(root, NASTY_NAME);
    await mkdir(cwd);
    const outFile = join(root, "argv.json");
    const script = await writeScript(
      "argv.mjs",
      `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(2)));
`,
    );

    const result = await openSession(
      { sessionId: "sess-1", cwd },
      {
        config: { sessionOpener: [process.execPath, script, outFile, "{cwd}"] },
        execFile: defaultExecFile,
      },
    );

    expect(result).toEqual({ status: "opened", sessionId: "sess-1", cwd });
    expect(await waitFor(outFile, 2000)).toBe(true);
    expect(JSON.parse(await readFile(outFile, "utf8"))).toEqual([outFile, cwd]);
  });

  it("reports a missing program as a failed spawn naming ENOENT", async () => {
    const result = await openSession(
      { sessionId: "sess-1", cwd: root },
      {
        config: { sessionOpener: [join(root, "no-such-opener"), "{cwd}"] },
        execFile: defaultExecFile,
      },
    );
    expect(result).toMatchObject({ status: "failed", reason: "spawn-failed" });
    expect((result as { message: string }).message).toMatch(/ENOENT/);
  });
});

describe("createDefaultExecFile: launch semantics, not exit semantics", () => {
  const request = () => ({ sessionId: "sess-1", cwd: root });

  it("reports opened once a long-running opener has survived the grace window, and leaves it running", async () => {
    const started = join(root, "long-started");
    const finished = join(root, "long-finished");
    const script = await writeScript(
      "long.mjs",
      `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], "started");
setTimeout(() => writeFileSync(process.argv[3], "finished"), 1500);
`,
    );
    const execFile = createDefaultExecFile({ graceMs: GRACE_MS });

    const begin = Date.now();
    const result = await openSession(request(), {
      config: { sessionOpener: [process.execPath, script, started, finished] },
      execFile,
    });
    const elapsed = Date.now() - begin;

    expect(result).toEqual({ status: "opened", sessionId: "sess-1", cwd: root });
    expect(elapsed).toBeLessThan(GRACE_MS + 1000);
    // The opener was still working when we reported success, and the engine did not kill it.
    expect(await exists(finished)).toBe(false);
    expect(await waitFor(finished, 4000)).toBe(true);
  });

  it("reports failed with the exit code when the opener exits non-zero inside the grace window", async () => {
    const execFile = createDefaultExecFile({ graceMs: 2000 });
    const result = await openSession(request(), {
      config: { sessionOpener: ["/usr/bin/false"] },
      execFile,
    });
    expect(result.status).not.toBe("opened");
    expect(result).toMatchObject({ status: "failed", reason: "spawn-failed" });
    expect((result as { message: string }).message).toMatch(/\b1\b/);
  });

  it("reports opened when the opener exits 0 inside the grace window", async () => {
    const execFile = createDefaultExecFile({ graceMs: 2000 });
    const result = await openSession(request(), {
      config: { sessionOpener: ["/usr/bin/true"] },
      execFile,
    });
    expect(result).toEqual({ status: "opened", sessionId: "sess-1", cwd: root });
  });

  it("does not kill an opener that writes more than 1 MiB to stderr", async () => {
    const execFile = createDefaultExecFile({ graceMs: GRACE_MS });
    const result = await openSession(request(), {
      config: {
        sessionOpener: [
          process.execPath,
          "-e",
          "process.stderr.write('x'.repeat(2 * 1024 * 1024)); setTimeout(() => {}, 1000);",
        ],
      },
      execFile,
    });
    expect(result).toEqual({ status: "opened", sessionId: "sess-1", cwd: root });
  });
});

describe("openSession: cwd must be an existing directory (when isDirectory is supplied)", () => {
  const config = { sessionOpener: ["/usr/bin/open", "{cwd}"] };

  function fakeExecFile() {
    return vi.fn<
      (file: string, args: string[], options: Record<string, unknown>) => Promise<unknown>
    >(async () => ({}));
  }

  it("defaultIsDirectory is true for a directory and false for a regular file or a missing path", async () => {
    const file = join(root, "plain.command");
    await writeFile(file, "#!/bin/sh\n");
    expect(await defaultIsDirectory(root)).toBe(true);
    expect(await defaultIsDirectory(file)).toBe(false);
    expect(await defaultIsDirectory(join(root, "does-not-exist"))).toBe(false);
  });

  it("refuses a cwd that is a regular file (such as an x.command script) and runs nothing", async () => {
    const file = join(root, "x.command");
    await writeFile(file, "#!/bin/sh\necho pwned\n");
    const execFile = fakeExecFile();
    const result = await openSession(
      { sessionId: "sess-1", cwd: file },
      { config, execFile, isDirectory: defaultIsDirectory },
    );
    expect(execFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", reason: "invalid-value", cwd: file });
    expect(result).toHaveProperty("message", expect.any(String));
  });

  it("refuses a cwd that does not exist and runs nothing", async () => {
    const missing = join(root, "missing-dir");
    const execFile = fakeExecFile();
    const result = await openSession(
      { sessionId: "sess-1", cwd: missing },
      { config, execFile, isDirectory: defaultIsDirectory },
    );
    expect(execFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", reason: "invalid-value" });
  });

  it("runs the opener when the cwd is an existing directory", async () => {
    const execFile = fakeExecFile();
    const result = await openSession(
      { sessionId: "sess-1", cwd: root },
      { config, execFile, isDirectory: defaultIsDirectory },
    );
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[1]).toEqual([root]);
    expect(result).toEqual({ status: "opened", sessionId: "sess-1", cwd: root });
  });

  it("consults the injected isDirectory with the request cwd and honours its answer", async () => {
    const isDirectory = vi.fn(async (_path: string) => false);
    const execFile = fakeExecFile();
    const refused = await openSession(
      { sessionId: "sess-1", cwd: "/Users/dev/repo" },
      { config, execFile, isDirectory },
    );
    expect(isDirectory).toHaveBeenCalledWith("/Users/dev/repo");
    expect(execFile).not.toHaveBeenCalled();
    expect(refused).toMatchObject({ status: "failed", reason: "invalid-value" });

    isDirectory.mockResolvedValueOnce(true);
    const allowed = await openSession(
      { sessionId: "sess-1", cwd: "/Users/dev/repo" },
      { config, execFile, isDirectory },
    );
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(allowed).toMatchObject({ status: "opened" });
  });
});
