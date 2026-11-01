import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootHarness,
  commandEvents,
  type Harness,
  type json,
  openBody,
  requestOpened,
  sessionStarted,
  types,
  useDbPath,
} from "./helpers.ts";

// M4.03 review fix (security M1). The recorded session working directory comes from telemetry, so
// it is not trusted to name what the opener runs on. Before the opener runs, the recorded
// `workingDirectory` is resolved with realpath and must lie inside one of the PROJECT's
// configured roots (project.created `roots`, the same roots project resolution uses; a root
// configured through a symlink counts by its real path too). Otherwise:
//   502 { error: { code: "opener_failed" }, command: { status: "failed" } }
//   events command.requested, command.failed; the opener never runs; the response never carries
//   the path.
// A resolved path whose last segment ends in .app, .command, .workflow, .terminal or .tool is
// refused the same way, even inside a root (macOS launches those). Only the last segment counts:
// `repo.application` is an ordinary directory.
// Not pinned here: copy-only mode (no opener configured) and a template without {cwd}.

const dbPath = useDbPath();
let harness: Harness | undefined;
let base = "";
let rootDir = "";
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "taskville-roots-")));
  rootDir = join(base, "root");
  mkdirSync(join(rootDir, "repo"), { recursive: true });
  mkdirSync(join(base, "outside"));
  mkdirSync(join(base, "root-evil"));
});
afterEach(() => {
  harness?.engine.close();
  harness = undefined;
  rmSync(base, { recursive: true, force: true });
});

const TEMPLATE = ["/usr/bin/open", "-a", "Terminal", "{cwd}", "--id={sessionId}"];

function boot(cwd: string, roots: string[] = [rootDir]): Harness {
  harness = bootHarness(dbPath(), {
    sessionOpener: TEMPLATE,
    roots,
    seed: [sessionStarted(cwd), requestOpened({})],
  });
  return harness;
}

async function expectRefused(h: Harness, secrets: string[]): Promise<void> {
  const res = await h.post(openBody());
  expect(res.status).toBe(502);
  const text = await res.text();
  const body = JSON.parse(text) as Awaited<ReturnType<typeof json>>;
  expect(body.error?.code).toBe("opener_failed");
  expect(body.command?.status).toBe("failed");
  for (const secret of secrets) expect(text).not.toContain(secret);
  expect(h.execFile).not.toHaveBeenCalled();
  const events = commandEvents(h.engine);
  expect(types(events)).toEqual(["command.requested", "command.failed"]);
  for (const secret of secrets) expect(JSON.stringify(events)).not.toContain(secret);
}

describe("session.open: the recorded cwd must lie inside a configured root", () => {
  it("runs the opener for a directory inside the root", async () => {
    const cwd = join(rootDir, "repo");
    const h = boot(cwd);
    const res = await h.post(openBody());
    expect(res.status).toBe(200);
    expect(h.execFile).toHaveBeenCalledTimes(1);
    expect(h.execFile.mock.calls[0]?.[1]).toContain(cwd);
  });

  it("runs the opener for the root itself", async () => {
    const h = boot(rootDir);
    expect((await h.post(openBody())).status).toBe(200);
    expect(h.execFile).toHaveBeenCalledTimes(1);
  });

  it("accepts a root configured through a symlink (matched by its real path)", async () => {
    const link = join(base, "link-root");
    symlinkSync(rootDir, link);
    const h = boot(join(rootDir, "repo"), [link]);
    expect((await h.post(openBody())).status).toBe(200);
    expect(h.execFile).toHaveBeenCalledTimes(1);
  });

  it("accepts a symlink inside the root that points at another directory inside it", async () => {
    mkdirSync(join(rootDir, "real-dir"));
    symlinkSync(join(rootDir, "real-dir"), join(rootDir, "alias"));
    const h = boot(join(rootDir, "alias"));
    expect((await h.post(openBody())).status).toBe(200);
    expect(h.execFile).toHaveBeenCalledTimes(1);
  });

  it("accepts a directory whose name only contains an app-like suffix (repo.application)", async () => {
    const cwd = join(rootDir, "repo.application");
    mkdirSync(cwd);
    const h = boot(cwd);
    expect((await h.post(openBody())).status).toBe(200);
    expect(h.execFile).toHaveBeenCalledTimes(1);
  });

  it("refuses a directory outside every root", async () => {
    const cwd = join(base, "outside");
    await expectRefused(boot(cwd), [cwd, base]);
  });

  it("refuses a sibling that only shares the root's name prefix (root-evil)", async () => {
    const cwd = join(base, "root-evil");
    await expectRefused(boot(cwd), [cwd, base]);
  });

  it("refuses a path that climbs out of the root with ..", async () => {
    const cwd = `${rootDir}/repo/../../outside`;
    await expectRefused(boot(cwd), [base]);
  });

  it("refuses a symlink inside the root that points outside it", async () => {
    const exit = join(rootDir, "exit-link");
    symlinkSync(join(base, "outside"), exit);
    await expectRefused(boot(exit), [exit, base]);
  });

  it("refuses everything when the project has no roots", async () => {
    const cwd = join(rootDir, "repo");
    await expectRefused(boot(cwd, []), [cwd, base]);
  });

  it("refuses a recorded directory that no longer exists", async () => {
    const cwd = join(rootDir, "deleted");
    await expectRefused(boot(cwd), [cwd, base]);
  });

  for (const suffix of [".app", ".command", ".workflow", ".terminal", ".tool"]) {
    it(`refuses a directory inside the root whose name ends in ${suffix}`, async () => {
      const cwd = join(rootDir, `Thing${suffix}`);
      mkdirSync(cwd);
      await expectRefused(boot(cwd), [cwd, base]);
    });
  }

  // M4.17 L3: the denylist also covers the other macOS bundle and package suffixes, matched
  // case-insensitively (the file system is).
  const MORE_SUFFIXES = [
    ".pkg",
    ".mpkg",
    ".prefpane",
    ".saver",
    ".action",
    ".service",
    ".qlgenerator",
    ".mdimporter",
    ".xpc",
    ".plugin",
    ".bundle",
    ".scptd",
    ".wdgt",
  ];
  for (const suffix of MORE_SUFFIXES) {
    it(`refuses a directory inside the root whose name ends in ${suffix}`, async () => {
      const cwd = join(rootDir, `Thing${suffix}`);
      mkdirSync(cwd);
      await expectRefused(boot(cwd), [cwd, base]);
    });

    it(`refuses ${suffix} regardless of case (x${suffix[0]}${suffix.slice(1).toUpperCase()})`, async () => {
      const cwd = join(rootDir, `x${suffix[0]}${suffix.slice(1).toUpperCase()}`);
      mkdirSync(cwd);
      await expectRefused(boot(cwd), [cwd, base]);
    });
  }

  it("refuses a mixed-case name such as x.prefPane", async () => {
    const cwd = join(rootDir, "x.prefPane");
    mkdirSync(cwd);
    await expectRefused(boot(cwd), [cwd, base]);
  });

  it("accepts a directory whose name only contains one of the new suffixes (repo.pkg-tools)", async () => {
    const cwd = join(rootDir, "repo.pkg-tools");
    mkdirSync(cwd);
    const h = boot(cwd);
    expect((await h.post(openBody())).status).toBe(200);
    expect(h.execFile).toHaveBeenCalledTimes(1);
  });

  it("refuses a symlink whose resolved path ends in .app", async () => {
    mkdirSync(join(rootDir, "Real.app"));
    const alias = join(rootDir, "harmless");
    symlinkSync(join(rootDir, "Real.app"), alias);
    await expectRefused(boot(alias), [alias, base]);
  });
});
