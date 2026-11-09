import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Io } from "../context.ts";
import { EXIT } from "../errors.ts";
import {
  approve,
  engineTarget,
  fail,
  plan,
  readSettings,
  showPath,
  unchangedSince,
} from "./install.ts";
import { settingsDiff } from "./install-diff.ts";
import { checkShim, installShim, removeFile, writeAtomic } from "./install-files.ts";
import {
  detectIndent,
  hookCommand,
  type Json,
  type JsonObject,
  put,
  removeTaskvilleHooks,
  serialize,
} from "./install-settings.ts";

// `taskville install codex` and `taskville uninstall codex` (A1.02, docs/spikes/S-5-codex.md
// "Recommendation"). Adds Taskville's hooks to <HOME>/.codex/hooks.json or
// <project>/.codex/hooks.json and never touches config.toml. Codex runs a new hook only after the
// user trusts it in `/hooks`, so the installer says so. Same rules as the Claude Code installer:
// the exact diff first, a yes before any write, the user's own hooks and unknown keys kept, a
// reinstall that changes nothing. Uninstall removes only Taskville's entries (a file install
// created is removed once nothing else is in it).

const INSTALL_USAGE =
  "taskville install codex --scope user|project [--project-dir <dir>] [--yes] [--dry-run] [--home <dir>] [--url <base>]";
const UNINSTALL_USAGE =
  "taskville uninstall codex --scope user|project [--project-dir <dir>] [--yes] [--dry-run] [--home <dir>]";

/** Telemetry hooks: asynchronous, so Codex never waits for them. */
export const CODEX_ASYNC_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "Interrupt",
  "SubagentStart",
  "PostModelRequest",
] as const;
/** Synchronous so they finish before Codex exits; the shim is bounded well inside the timeout. */
export const CODEX_SYNC_EVENTS = ["SessionEnd", "SubagentStop"] as const;
/** The forwarder's hook: synchronous, because its answer is the decision. */
export const CODEX_PERMISSION_EVENT = "PermissionRequest";

/** Seconds a synchronous telemetry hook may run (the shim's waits total about 2 s at worst). */
export const SYNC_TIMEOUT_SECONDS = 3;
/** Seconds the forwarder may run: the engine's 5 s Codex hold window plus a 5 s margin. */
export const PERMISSION_TIMEOUT_SECONDS = 10;

export const CODEX_SHIM_NAME = "taskville-codex-shim.sh";
export const CODEX_PERMISSION_NAME = "taskville-codex-permission.sh";

const SHIM_SOURCE = new URL("../../hooks/codex-shim.sh", import.meta.url);
const PERMISSION_SOURCE = new URL("../../hooks/codex-permission-bridge.sh", import.meta.url);

// Exactly the commands `hookCommand` produces for either of the two copies.
const QUOTED = `'(?:[^']|'\\\\'')*'`;
const NAMES = [CODEX_SHIM_NAME, CODEX_PERMISSION_NAME]
  .map((name) => name.replaceAll(".", "\\."))
  .join("|");
const MARKER = new RegExp(
  `^(?:TASKVILLE_HOME=${QUOTED} )?(?:TASKVILLE_URL=${QUOTED} )?'(?:[^']|'\\\\'')*/(?:${NAMES})'$`,
);

/** True for a command handler this installer wrote. */
export function isTaskvilleCodexHook(handler: unknown): boolean {
  if (handler === null || typeof handler !== "object" || Array.isArray(handler)) return false;
  const h = handler as Record<string, unknown>;
  return h.type === "command" && typeof h.command === "string" && MARKER.test(h.command);
}

interface Commands {
  shim: string;
  permission: string;
}

/** Settings with exactly one Taskville handler per event: the shim, and the forwarder for PermissionRequest. */
export function addCodexHooks(settings: JsonObject, commands: Commands): JsonObject {
  const base = removeTaskvilleHooks(settings, isTaskvilleCodexHook).settings;
  const own = (hooks: JsonObject, event: string): Json[] =>
    Object.hasOwn(hooks, event) ? (hooks[event] as Json[]) : [];
  let hooks: JsonObject =
    Object.hasOwn(base, "hooks") && typeof base.hooks === "object"
      ? (base.hooks as JsonObject)
      : {};
  const add = (event: string, handler: JsonObject) => {
    hooks = put(hooks, event, [...own(hooks, event), { hooks: [handler] }]);
  };
  for (const event of CODEX_ASYNC_EVENTS) {
    add(event, { type: "command", command: commands.shim, async: true });
  }
  for (const event of CODEX_SYNC_EVENTS) {
    add(event, { type: "command", command: commands.shim, timeout: SYNC_TIMEOUT_SECONDS });
  }
  add(CODEX_PERMISSION_EVENT, {
    type: "command",
    command: commands.permission,
    timeout: PERMISSION_TIMEOUT_SECONDS,
  });
  return put(base, "hooks", hooks);
}

export async function installCodex(io: Io, args: string[]): Promise<number> {
  const p = plan(io, args, INSTALL_USAGE, "codex");
  const { url } = engineTarget(p);
  if (!isAbsolute(p.home)) fail(`the Taskville home ${p.home} is not absolute`);
  const shimSource = readFileSync(SHIM_SOURCE, "utf8");
  const permissionSource = readFileSync(PERMISSION_SOURCE, "utf8");
  const shim = checkShim(p.home, CODEX_SHIM_NAME, shimSource);
  const permission = checkShim(p.home, CODEX_PERMISSION_NAME, permissionSource);
  // Both variables are always set, so an inherited TASKVILLE_URL or TASKVILLE_HOME in Codex's
  // environment cannot win over what was installed.
  const commands: Commands = {
    shim: hookCommand({ shimPath: shim.path, home: p.home, url }),
    permission: hookCommand({ shimPath: permission.path, home: p.home, url }),
  };

  const { state, settings } = readSettings(p.target);
  const planned = addCodexHooks(settings, commands);
  const settingsDone = JSON.stringify(planned) === JSON.stringify(settings);
  if (settingsDone && !shim.changes && !permission.changes) {
    io.stdout(`Already installed in ${showPath(p.target)}; nothing to change.\n`);
    return EXIT.ok;
  }
  const next = settingsDone ? state.text : serialize(planned, detectIndent(state.text ?? ""));
  const diff = settingsDiff(p.target.shown, state.text, next);
  const extra = [
    `Hook command: ${commands.shim}`,
    `Permission command: ${commands.permission}`,
    shim.changes ? `Shim: copy to ${shim.path} (0755)` : `Shim: ${shim.path} is current`,
    permission.changes
      ? `Permission forwarder: copy to ${permission.path} (0755)`
      : `Permission forwarder: ${permission.path} is current`,
  ];
  if (!(await approve(p, diff, extra, `Write these hooks to ${p.target.shown}?`))) {
    return p.values["dry-run"] === true ? EXIT.ok : EXIT.failure;
  }
  unchangedSince(p, state);

  installShim(p.home, CODEX_SHIM_NAME, shimSource);
  installShim(p.home, CODEX_PERMISSION_NAME, permissionSource);
  if (!settingsDone && next !== undefined) writeAtomic(p.target.path, next, state.mode);
  io.stdout(
    `Installed Taskville hooks for ${CODEX_ASYNC_EVENTS.length + CODEX_SYNC_EVENTS.length} events and the permission forwarder (${CODEX_PERMISSION_EVENT}) in ${showPath(p.target)}.\n`,
  );
  io.stdout(
    "Codex runs a new hook only after you trust it: start Codex, open /hooks, and trust the Taskville hooks.\n",
  );
  return EXIT.ok;
}

export async function uninstallCodex(io: Io, args: string[]): Promise<number> {
  const p = plan(io, args, UNINSTALL_USAGE, "codex");
  const { state, settings } = readSettings(p.target);
  const { settings: stripped, removed } = removeTaskvilleHooks(settings, isTaskvilleCodexHook);
  if (removed === 0) {
    io.stdout(`Taskville hooks are not installed in ${showPath(p.target)}; nothing to change.\n`);
    return EXIT.ok;
  }
  // A file left with nothing in it held only Taskville's hooks (install made it): remove it.
  const empty = Object.keys(stripped).length === 0;
  const next = empty ? undefined : serialize(stripped, detectIndent(state.text ?? ""));
  const how = empty
    ? "nothing else is in this file, so it is removed"
    : "removing only Taskville's entries";
  const diff = settingsDiff(p.target.shown, state.text, next);
  if (
    !(await approve(
      p,
      diff,
      [`Uninstall: ${how}.`],
      `Remove Taskville's hooks from ${p.target.shown}?`,
    ))
  ) {
    return p.values["dry-run"] === true ? EXIT.ok : EXIT.failure;
  }
  unchangedSince(p, state);

  if (next === undefined) removeFile(p.target.path);
  else writeAtomic(p.target.path, next, state.mode);
  io.stdout(
    `Removed ${removed} Taskville hook entries from ${showPath(p.target)}. The script copies in ${p.home}/hooks are left for any other scope that still uses them.\n`,
  );
  return EXIT.ok;
}
