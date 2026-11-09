import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isLink, json, mode, read, type Sandbox, sandbox, tv } from "./helpers.ts";

// A1.02 (#507): `taskville install codex --scope user|project` and `uninstall codex`
// (docs/spikes/S-5-codex.md "Recommendation"). Entries go into <HOME>/.codex/hooks.json or
// <repo>/.codex/hooks.json, never config.toml. Always a temporary HOME and project directory.
//
// Pinned shape (same group layout as the Claude Code installer, no matcher):
// - telemetry shim: apps/cli/hooks/codex-shim.sh, copied to <taskville home>/hooks/
//   taskville-codex-shim.sh; command `TASKVILLE_HOME='..' TASKVILLE_URL='..' '<copy>'`;
// - permission forwarder: apps/cli/hooks/codex-permission-bridge.sh, copied to
//   <taskville home>/hooks/taskville-codex-permission.sh, run for PermissionRequest;
// - async telemetry events, synchronous SessionEnd and SubagentStop (timeout 1 to 3 s),
//   synchronous PermissionRequest (timeout just above the 5 s hold: 6 to 15 s).

const ASYNC_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "Interrupt",
  "SubagentStart",
  "PostModelRequest",
];
const SYNC_EVENTS = ["SessionEnd", "SubagentStop"];

// The real files must never change while this suite runs.
const REAL = [".codex/hooks.json", ".codex/config.toml"].map((f) => join(homedir(), f));
const stamp = (p: string) =>
  existsSync(p) ? `${statSync(p).mtimeMs}:${statSync(p).size}` : "absent";
let realBefore: string[] = [];
beforeAll(() => {
  realBefore = REAL.map(stamp);
});
afterAll(() => {
  expect(REAL.map(stamp), "the real ~/.codex files must never be touched").toEqual(realBefore);
});

let sb: Sandbox;
afterEach(() => sb?.remove());

const userHooks = (box: Sandbox) => join(box.home, ".codex", "hooks.json");
const projectHooks = (box: Sandbox) => join(box.project, ".codex", "hooks.json");
const userToml = (box: Sandbox) => join(box.home, ".codex", "config.toml");
const projectToml = (box: Sandbox) => join(box.project, ".codex", "config.toml");
const shimCopy = (box: Sandbox) => join(box.tv, "hooks", "taskville-codex-shim.sh");
const permissionCopy = (box: Sandbox) => join(box.tv, "hooks", "taskville-codex-permission.sh");
const HOOKS_DIR = join(import.meta.dirname, "../../hooks");

const commandFor = (path: string, box: Sandbox, url = "http://127.0.0.1:4807") =>
  `TASKVILLE_HOME='${box.tv}' TASKVILLE_URL='${url}' '${path}'`;

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
type Handler = Record<string, unknown>;
type Hooks = Record<string, { matcher?: string; hooks: Handler[] }[]>;
const hooksOf = (path: string) => json(path).hooks as Hooks;
const ours = (path: string) =>
  Object.entries(hooksOf(path)).flatMap(([event, groups]) =>
    groups.flatMap((g) =>
      g.hooks
        .filter((h) => String(h.command).includes("taskville-codex-"))
        .map((h) => ({ event, h })),
    ),
  );
const install = (box: Sandbox, scope: string, extra: string[] = []) =>
  tv(box, ["install", "codex", "--scope", scope, ...extra]);

describe("install codex --scope user", () => {
  it("writes async telemetry hooks, synchronous lifecycle-end hooks and a synchronous permission forwarder", async () => {
    sb = sandbox();
    const r = await install(sb, "user", ["--yes"]);
    expect(r.code, r.stderr).toBe(0);
    const hooks = hooksOf(userHooks(sb));
    expect(Object.keys(hooks).sort()).toEqual(
      [...ASYNC_EVENTS, ...SYNC_EVENTS, "PermissionRequest"].sort(),
    );
    for (const event of ASYNC_EVENTS) {
      expect(hooks[event], event).toHaveLength(1);
      expect(hooks[event]?.[0]?.matcher).toBeUndefined();
      expect(hooks[event]?.[0]?.hooks).toEqual([
        expect.objectContaining({
          type: "command",
          command: commandFor(shimCopy(sb), sb),
          async: true,
        }),
      ]);
    }
    for (const event of SYNC_EVENTS) {
      const [handler] = hooks[event]?.[0]?.hooks ?? [];
      expect(handler, event).toMatchObject({
        type: "command",
        command: commandFor(shimCopy(sb), sb),
      });
      expect(handler?.async === undefined || handler.async === false, event).toBe(true);
      expect(handler?.timeout, event).toBeGreaterThanOrEqual(1);
      expect(handler?.timeout, event).toBeLessThanOrEqual(3);
    }
    const [permission] = hooks.PermissionRequest?.[0]?.hooks ?? [];
    expect(hooks.PermissionRequest).toHaveLength(1);
    expect(hooks.PermissionRequest?.[0]?.matcher).toBeUndefined();
    expect(permission).toMatchObject({
      type: "command",
      command: commandFor(permissionCopy(sb), sb),
    });
    expect(permission?.async === undefined || permission.async === false).toBe(true);
    expect(permission?.timeout).toBeGreaterThan(5);
    expect(permission?.timeout).toBeLessThanOrEqual(15);
  });

  it("copies both scripts into the Taskville home, private and executable", async () => {
    sb = sandbox();
    expect((await install(sb, "user", ["--yes"])).code).toBe(0);
    expect(read(shimCopy(sb))).toBe(read(join(HOOKS_DIR, "codex-shim.sh")));
    expect(read(permissionCopy(sb))).toBe(read(join(HOOKS_DIR, "codex-permission-bridge.sh")));
    for (const copy of [shimCopy(sb), permissionCopy(sb)]) {
      expect(mode(copy)).toBe(0o755);
      expect(isLink(copy)).toBe(false);
    }
    expect(mode(dirname(shimCopy(sb)))).toBe(0o700);
  });

  it("tells the user to open /hooks to trust the new hooks", async () => {
    sb = sandbox();
    const r = await install(sb, "user", ["--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\/hooks/);
    expect(r.stdout).toMatch(/trust/i);
  });

  it("never touches config.toml: not created, and an existing one stays byte for byte", async () => {
    sb = sandbox();
    expect((await install(sb, "user", ["--yes"])).code).toBe(0);
    expect(existsSync(userToml(sb))).toBe(false);
    sb.remove();

    sb = sandbox();
    const toml = `# my codex config\nmodel = "gpt-6-luna"\n\n[hooks.state]\n`;
    write(userToml(sb), toml);
    expect((await install(sb, "user", ["--yes"])).code).toBe(0);
    expect(read(userToml(sb))).toBe(toml);
    expect((await tv(sb, ["uninstall", "codex", "--scope", "user", "--yes"])).code).toBe(0);
    expect(read(userToml(sb))).toBe(toml);
  });

  it("prints the exact diff and writes nothing without --yes or a confirmation", async () => {
    sb = sandbox();
    const r = await install(sb, "user");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(userHooks(sb));
    expect(r.stdout).toContain(`+    "SessionStart": [`);
    expect(r.stdout).toContain(`+    "PermissionRequest": [`);
    expect(r.stderr).toMatch(/--yes/);
    expect(existsSync(userHooks(sb))).toBe(false);
    expect(existsSync(shimCopy(sb))).toBe(false);
    expect(existsSync(permissionCopy(sb))).toBe(false);
  });

  it("asks before writing and respects the answer", async () => {
    sb = sandbox();
    const questions: string[] = [];
    const no = await tv(sb, ["install", "codex", "--scope", "user"], {
      confirm: async (q) => {
        questions.push(q);
        return false;
      },
    });
    expect(no.code).toBe(1);
    expect(questions).toHaveLength(1);
    expect(existsSync(userHooks(sb))).toBe(false);
    const yes = await tv(sb, ["install", "codex", "--scope", "user"], {
      confirm: async () => true,
    });
    expect(yes.code, yes.stderr).toBe(0);
    expect(ours(userHooks(sb)).length).toBeGreaterThan(0);
  });

  it("--dry-run prints the diff and writes nothing", async () => {
    sb = sandbox();
    const r = await install(sb, "user", ["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`"async": true`);
    expect(r.stdout).toContain(userHooks(sb));
    expect(existsSync(userHooks(sb))).toBe(false);
    expect(existsSync(shimCopy(sb))).toBe(false);
    expect(existsSync(dirname(userHooks(sb)))).toBe(false);
  });

  it("keeps the user's own hooks and every unknown key", async () => {
    sb = sandbox();
    const other = { type: "command", command: "roborev agent-hook --event pre" };
    write(
      userHooks(sb),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [other] }],
            Stop: [{ hooks: [other] }],
            PermissionRequest: [{ hooks: [other] }],
          },
          custom: { nested: [1, { x: null }] },
        },
        null,
        2,
      )}\n`,
    );
    expect((await install(sb, "user", ["--yes"])).code).toBe(0);
    const after = json(userHooks(sb));
    expect(after.custom).toEqual({ nested: [1, { x: null }] });
    const hooks = after.hooks as Hooks;
    expect(hooks.PreToolUse?.[0]).toEqual({ matcher: "Bash", hooks: [other] });
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.Stop?.[0]).toEqual({ hooks: [other] });
    expect(hooks.PermissionRequest?.[0]).toEqual({ hooks: [other] });
    expect(hooks.PermissionRequest).toHaveLength(2);
  });

  it("is idempotent: a reinstall changes nothing and adds no duplicates", async () => {
    sb = sandbox();
    expect((await install(sb, "user", ["--yes"])).code).toBe(0);
    const first = read(userHooks(sb));
    const count = ours(userHooks(sb)).length;
    const again = await install(sb, "user", ["--yes"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/already installed/i);
    expect(read(userHooks(sb))).toBe(first);
    expect(ours(userHooks(sb))).toHaveLength(count);
    expect(count).toBe(ASYNC_EVENTS.length + SYNC_EVENTS.length + 1);
  });

  it("replaces its own entries when the engine URL changes, not duplicating them", async () => {
    sb = sandbox();
    await install(sb, "user", ["--yes"]);
    const r = await install(sb, "user", ["--yes", "--url", "http://127.0.0.1:5123"]);
    expect(r.code, r.stderr).toBe(0);
    const entries = ours(userHooks(sb));
    expect(entries).toHaveLength(ASYNC_EVENTS.length + SYNC_EVENTS.length + 1);
    expect(new Set(entries.map((e) => e.h.command))).toEqual(
      new Set([
        commandFor(shimCopy(sb), sb, "http://127.0.0.1:5123"),
        commandFor(permissionCopy(sb), sb, "http://127.0.0.1:5123"),
      ]),
    );
  });

  it("refuses a malformed hooks.json and leaves it untouched", async () => {
    for (const text of ["{ not json", "[]", `{"hooks": []}`]) {
      sb = sandbox();
      write(userHooks(sb), text);
      const r = await install(sb, "user", ["--yes"]);
      expect(r.code, text).toBe(1);
      expect(read(userHooks(sb))).toBe(text);
      sb.remove();
    }
  });
});

describe("install codex --scope project", () => {
  it("writes <project>/.codex/hooks.json and leaves the user file and both config.toml alone", async () => {
    sb = sandbox();
    const r = await install(sb, "project", ["--yes"]);
    expect(r.code, r.stderr).toBe(0);
    const hooks = hooksOf(projectHooks(sb));
    expect(Object.keys(hooks).sort()).toEqual(
      [...ASYNC_EVENTS, ...SYNC_EVENTS, "PermissionRequest"].sort(),
    );
    expect(existsSync(userHooks(sb))).toBe(false);
    expect(existsSync(projectToml(sb))).toBe(false);
    expect(existsSync(userToml(sb))).toBe(false);
    expect(r.stdout).toMatch(/\/hooks/);
  });

  it("honours --project-dir", async () => {
    sb = sandbox();
    const elsewhere = join(sb.root, "elsewhere");
    mkdirSync(elsewhere);
    const r = await install(sb, "project", ["--yes", "--project-dir", elsewhere]);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(elsewhere, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(projectHooks(sb))).toBe(false);
  });

  it("--dry-run writes nothing and a reinstall is idempotent", async () => {
    sb = sandbox();
    expect((await install(sb, "project", ["--dry-run"])).code).toBe(0);
    expect(existsSync(projectHooks(sb))).toBe(false);
    expect((await install(sb, "project", ["--yes"])).code).toBe(0);
    const first = read(projectHooks(sb));
    const again = await install(sb, "project", ["--yes"]);
    expect(again.stdout).toMatch(/already installed/i);
    expect(read(projectHooks(sb))).toBe(first);
  });
});

describe("uninstall codex", () => {
  it("removes only Taskville's entries and keeps the user's hooks", async () => {
    sb = sandbox();
    const other = { type: "command", command: "roborev agent-hook --event pre" };
    const original = {
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [other] }], Stop: [{ hooks: [other] }] },
      custom: true,
    };
    write(userHooks(sb), `${JSON.stringify(original, null, 2)}\n`);
    expect((await install(sb, "user", ["--yes"])).code).toBe(0);
    expect(ours(userHooks(sb)).length).toBeGreaterThan(0);

    const r = await tv(sb, ["uninstall", "codex", "--scope", "user", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(ours(userHooks(sb))).toEqual([]);
    expect(json(userHooks(sb))).toEqual(original);
  });

  it("removes a file install created, and says so when nothing is installed", async () => {
    sb = sandbox();
    expect((await install(sb, "project", ["--yes"])).code).toBe(0);
    expect((await tv(sb, ["uninstall", "codex", "--scope", "project", "--yes"])).code).toBe(0);
    expect(existsSync(projectHooks(sb))).toBe(false);
    const again = await tv(sb, ["uninstall", "codex", "--scope", "project", "--yes"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/not installed/i);
  });

  it("--dry-run shows the removal and writes nothing", async () => {
    sb = sandbox();
    await install(sb, "user", ["--yes"]);
    const before = read(userHooks(sb));
    const r = await tv(sb, ["uninstall", "codex", "--scope", "user", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("-");
    expect(read(userHooks(sb))).toBe(before);
  });
});
