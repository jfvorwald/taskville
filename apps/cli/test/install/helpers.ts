import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect } from "vitest";
import type { Io } from "../../src/main.ts";
import { cli, tempDir } from "../helpers.ts";

// HARD RULE (#29): install and uninstall only ever run against a temporary HOME and temporary
// project directories. `sandbox()` gives each test its own, and `guardRealSettings()` fails the
// file if the real user settings file changed while it ran.

export interface Sandbox {
  root: string;
  /** Stands in for $HOME. */
  home: string;
  /** The Taskville home (--home). */
  tv: string;
  /** A project directory for --scope project. */
  project: string;
  userSettings: string;
  projectSettings: string;
  shim: string;
  remove(): void;
}

export function sandbox(prefix = "taskville-install-"): Sandbox {
  const dir = tempDir(prefix);
  const home = join(dir.path, "home");
  const project = join(dir.path, "project");
  mkdirSync(home);
  mkdirSync(project);
  const tv = join(home, ".taskville");
  return {
    root: dir.path,
    home,
    tv,
    project,
    userSettings: join(home, ".claude", "settings.json"),
    projectSettings: join(project, ".claude", "settings.local.json"),
    shim: join(tv, "hooks", "taskville-claude-code-shim.sh"),
    remove: dir.remove,
  };
}

/** Runs the CLI with HOME pointing into the sandbox and nothing else from the real environment. */
export function tv(sb: Sandbox, argv: string[], io: Partial<Io> = {}) {
  return cli(argv, { env: { HOME: sb.home }, cwd: sb.project, ...io });
}

export const read = (path: string) => readFileSync(path, "utf8");
export const json = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;
export const mode = (path: string) => statSync(path).mode & 0o777;
export const isLink = (path: string) => lstatSync(path).isSymbolicLink();

/** Fails the suite if the real ~/.claude/settings.json changed while it ran. */
export function guardRealSettings(): void {
  const real = join(homedir(), ".claude", "settings.json");
  let before: string | undefined;
  beforeAll(() => {
    before = existsSync(real) ? `${statSync(real).mtimeMs}:${statSync(real).size}` : "absent";
  });
  afterAll(() => {
    const after = existsSync(real) ? `${statSync(real).mtimeMs}:${statSync(real).size}` : "absent";
    expect(after, "the real user settings file must never be touched").toBe(before);
  });
}

/** The env var that carries the bridge token to Claude Code's http hook (never written to settings). */
export const BRIDGE_ENV = "TASKVILLE_BRIDGE_TOKEN";

/**
 * The PermissionRequest `http` hook `taskville install claude-code` writes (M4.04, #61; shape from
 * spike S-1 `fixtures/claude-code/permission/hook-settings.json`): the engine URL's bridge route,
 * the bridge token through `allowedEnvVars` (the header holds the variable, not the token), and a
 * `timeout` of the hold window plus 5 s (default 90 + 5). No matcher: it covers every tool.
 */
export const bridgeHook = (url = "http://127.0.0.1:4807", timeout = 95) => ({
  type: "http",
  url: `${url}/v1/bridge/claude-code/permission`,
  timeout,
  headers: { Authorization: `Bearer $${BRIDGE_ENV}` },
  allowedEnvVars: [BRIDGE_ENV],
});

/** The 15 async command-hook events of ARCHITECTURE.md 8.1; PermissionRequest (M4.04) is separate. */
export const EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "Elicitation",
];
