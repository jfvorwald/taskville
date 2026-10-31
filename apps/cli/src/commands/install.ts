import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { loadConfig } from "@taskville/engine/src/config/config.ts";
import { resolveHome } from "@taskville/engine/src/config/home.ts";
import { type Io, parseCommand, type Values } from "../context.ts";
import { CliError, EXIT } from "../errors.ts";
import { settingsDiff } from "./install-diff.ts";
import {
  backupPath,
  checkShim,
  type FileState,
  installShim,
  projectSettingsTarget,
  readBackup,
  readState,
  removeFile,
  type SettingsTarget,
  userSettingsTarget,
  writeAtomic,
  writeBackupOnce,
} from "./install-files.ts";
import {
  addTaskvilleHooks,
  detectIndent,
  HOOK_EVENTS,
  hookCommand,
  isTaskvilleHook,
  type JsonObject,
  parseSettings,
  removeTaskvilleHooks,
  SettingsError,
  SHIM_NAME,
  serialize,
} from "./install-settings.ts";

// `taskville install claude-code` and `taskville uninstall claude-code` (#29, ARCHITECTURE.md 8.1
// "Installing"). Adds one async command hook per telemetry event, pointing at a copy of the shim
// in the Taskville home; shows the exact settings diff and asks before writing.
//
// What uninstall guarantees: if nothing but Taskville's entries changed since the first install,
// the settings file comes back byte for byte (or is removed, if install created it), from the
// backup kept next to it. Otherwise only Taskville's entries are removed and the file is rewritten
// with its own indent; JSON that round-trips differently (escapes, number forms) may be
// reformatted, and the diff shows it before anything is written.

const INSTALL_USAGE =
  "taskville install claude-code --scope user|project [--project-dir <dir>] [--yes] [--dry-run] [--home <dir>] [--url <base>]";
const UNINSTALL_USAGE =
  "taskville uninstall claude-code --scope user|project [--project-dir <dir>] [--yes] [--dry-run] [--home <dir>]";

const OPTIONS = {
  scope: { type: "string" },
  "project-dir": { type: "string" },
  yes: { type: "boolean" },
  "dry-run": { type: "boolean" },
} as const;

const SHIM_SOURCE = new URL("../../hooks/claude-code-shim.sh", import.meta.url);

const usageError = (message: string, usage: string): never => {
  throw new CliError(EXIT.failure, `${message}\nUsage: ${usage}`);
};
const fail = (message: string): never => {
  throw new CliError(EXIT.failure, message);
};

interface Plan {
  io: Io;
  scope: "user" | "project";
  target: SettingsTarget;
  home: string;
  values: Values;
}

function plan(io: Io, args: string[], usage: string): Plan {
  const [target, ...rest] = args;
  if (target !== "claude-code") usageError(`unknown or missing target "${target ?? ""}"`, usage);
  const { values } = parseCommand(io, rest, OPTIONS, usage);
  const scope = values.scope;
  if (scope !== "user" && scope !== "project") usageError("--scope must be user or project", usage);

  // Never fall back to the OS home directory: HOME comes from the caller's environment only, so a
  // test or a scripted run can never reach the real user settings by accident.
  const userHome = nonEmpty(io.env.HOME);
  const home = resolveTaskvilleHome(io, values, userHome);
  let settings: SettingsTarget;
  if (scope === "user") {
    const configDir = nonEmpty(io.env.CLAUDE_CONFIG_DIR);
    if (configDir === undefined && userHome === undefined) {
      fail(
        "HOME is not set, so the user settings file cannot be located; set HOME or CLAUDE_CONFIG_DIR",
      );
    }
    const dir =
      configDir === undefined ? join(userHome as string, ".claude") : resolve(io.cwd, configDir);
    settings = userSettingsTarget(dir);
  } else {
    const dir = values["project-dir"];
    settings = projectSettingsTarget(resolve(io.cwd, typeof dir === "string" ? dir : "."));
  }
  return { io, scope: scope as "user" | "project", target: settings, home, values };
}

const nonEmpty = (value: string | undefined) =>
  value === undefined || value === "" ? undefined : value;

function resolveTaskvilleHome(io: Io, values: Values, userHome: string | undefined): string {
  const flag = values.home as string | undefined;
  if (
    nonEmpty(flag) === undefined &&
    nonEmpty(io.env.TASKVILLE_HOME) === undefined &&
    userHome === undefined
  ) {
    fail("HOME is not set, so the Taskville home cannot be located; pass --home");
  }
  return resolveHome({ flag, env: io.env, cwd: io.cwd, homedir: userHome ?? "/nonexistent" });
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):([0-9]{1,5})\/?$/;

/**
 * The engine URL for the hook: `--url`, else `$TASKVILLE_URL`, else config.json's port. Only the
 * loopback forms the shim will contact are accepted.
 */
function engineUrl(p: Plan): string {
  const raw = (p.values.url as string | undefined) ?? nonEmpty(p.io.env.TASKVILLE_URL);
  if (raw === undefined) {
    const userHome = nonEmpty(p.io.env.HOME);
    let port: number;
    try {
      ({ port } = loadConfig({
        home: p.home,
        ...(userHome === undefined ? {} : { homedir: userHome }),
      }).config);
    } catch (error) {
      return fail(`cannot read the Taskville config: ${(error as Error).message}`);
    }
    return `http://127.0.0.1:${port}`;
  }
  const match = LOOPBACK.exec(raw);
  const port = Number(match?.[2]);
  if (match === null || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return fail(
      `--url ${raw} is not http://127.0.0.1:<port> or http://localhost:<port>; the shim contacts nothing else`,
    );
  }
  return `http://${match[1]}:${port}`;
}

function readSettings(target: SettingsTarget): { state: FileState; settings: JsonObject } {
  const state = readState(target.path);
  if (state.text === undefined) return { state, settings: {} };
  try {
    return { state, settings: parseSettings(state.text) };
  } catch (error) {
    if (error instanceof SettingsError) {
      return fail(
        `settings file ${target.shown} ${error.message}; fix it first, nothing was written`,
      );
    }
    throw error;
  }
}

const showPath = (t: SettingsTarget) => (t.shown === t.path ? t.path : `${t.shown} -> ${t.path}`);

/** Prints the diff, then gets a yes: --yes, an interactive answer, or a refusal. */
async function approve(p: Plan, diff: string, extra: string[], question: string): Promise<boolean> {
  p.io.stdout(`Settings file: ${showPath(p.target)}\n`);
  for (const line of extra) p.io.stdout(`${line}\n`);
  p.io.stdout(diff);
  if (p.values["dry-run"] === true) {
    p.io.stdout("Dry run: nothing was written.\n");
    return false;
  }
  if (p.values.yes === true) return true;
  if (p.io.confirm === undefined) {
    fail("not a terminal, so nothing was written; review the diff above and rerun with --yes");
  }
  const answer = await (p.io.confirm as (q: string) => Promise<boolean>)(question);
  if (!answer) fail("not confirmed; nothing was written");
  return true;
}

/** Refuses if the file changed while the user read the diff. */
function unchangedSince(p: Plan, before: FileState): void {
  const now = readState(p.target.path);
  if (now.text !== before.text)
    fail(
      `settings file ${p.target.shown} changed while waiting; nothing was written, rerun to see the new diff`,
    );
}

/** A matcher that matches every occurrence: absent, "", or "*" (hooks reference). */
const matchesAll = (group: Record<string, unknown>) =>
  !Object.hasOwn(group, "matcher") || group.matcher === "" || group.matcher === "*";

/**
 * True when the file already has exactly one Taskville handler per event, running `command`, in a
 * group that matches every occurrence. A group someone narrowed with a matcher does not count, so
 * a reinstall restores full coverage (roborev 5200).
 */
function alreadyInstalled(settings: JsonObject, command: string): boolean {
  const hooks = settings.hooks;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const found: { event: string; handler: Record<string, unknown>; all: boolean }[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups as Record<string, unknown>[]) {
      const handlers = Array.isArray(group.hooks) ? group.hooks : [];
      for (const handler of handlers.filter(isTaskvilleHook)) {
        found.push({ event, handler: handler as Record<string, unknown>, all: matchesAll(group) });
      }
    }
  }
  if (found.length !== HOOK_EVENTS.length) return false;
  const events = new Set(found.map((x) => x.event));
  return (
    HOOK_EVENTS.every((e) => events.has(e)) &&
    found.every(
      (x) =>
        x.all &&
        Object.keys(x.handler).length === 3 &&
        x.handler.command === command &&
        x.handler.async === true,
    )
  );
}

export async function install(io: Io, args: string[]): Promise<number> {
  const p = plan(io, args, INSTALL_USAGE);
  const url = engineUrl(p);
  if (!isAbsolute(p.home)) fail(`the Taskville home ${p.home} is not absolute`);
  const shimSource = readFileSync(SHIM_SOURCE, "utf8");
  const shim = checkShim(p.home, SHIM_NAME, shimSource);
  // Both variables are always set: the hook runs in Claude Code's environment, where an inherited
  // TASKVILLE_URL or TASKVILLE_HOME would otherwise win over what was installed (roborev 5200).
  const command = hookCommand({ shimPath: shim.path, home: p.home, url });

  const { state, settings } = readSettings(p.target);
  const settingsDone = alreadyInstalled(settings, command);
  if (settingsDone && !shim.changes) {
    io.stdout(`Already installed in ${showPath(p.target)}; nothing to change.\n`);
    return EXIT.ok;
  }
  const next = settingsDone
    ? state.text
    : serialize(addTaskvilleHooks(settings, command), detectIndent(state.text ?? ""));
  const diff = settingsDiff(p.target.shown, state.text, next);
  const extra = [
    `Hook command: ${command}`,
    shim.changes ? `Shim: copy to ${shim.path} (0755)` : `Shim: ${shim.path} is current`,
  ];
  if (!(await approve(p, diff, extra, `Write these hooks to ${p.target.shown}?`))) {
    return p.values["dry-run"] === true ? EXIT.ok : EXIT.failure;
  }
  unchangedSince(p, state);

  installShim(p.home, SHIM_NAME, shimSource);
  if (!settingsDone && next !== undefined) {
    // Keep the original for a byte-for-byte uninstall, unless an earlier install's entries are
    // already in it (then the first install's backup, if any, is the original).
    if (removeTaskvilleHooks(settings).removed === 0) writeBackupOnce(p.target.path, state);
    writeAtomic(p.target.path, next, state.mode);
  }
  io.stdout(
    `Installed Taskville hooks for ${HOOK_EVENTS.length} events in ${showPath(p.target)}.\n`,
  );
  if (p.scope === "project") {
    io.stdout(
      "Note: .claude/settings.local.json holds machine-specific paths. Claude Code git-ignores it only when it creates the file itself, so add it to .gitignore if this project is a git repository.\n",
    );
  }
  return EXIT.ok;
}

export async function uninstall(io: Io, args: string[]): Promise<number> {
  const p = plan(io, args, UNINSTALL_USAGE);
  const { state, settings } = readSettings(p.target);
  const { settings: stripped, removed } = removeTaskvilleHooks(settings);
  if (removed === 0) {
    io.stdout(`Taskville hooks are not installed in ${showPath(p.target)}; nothing to change.\n`);
    return EXIT.ok;
  }

  // Byte-for-byte restore when the backup says what the file was and nothing else changed since.
  const backup = readBackup(p.target.path);
  let next: string | undefined = serialize(stripped, detectIndent(state.text ?? ""));
  let how = "removing only Taskville's entries";
  if (backup === "" && Object.keys(stripped).length === 0) {
    next = undefined;
    how = "install created this file, so it is removed";
  } else if (backup !== undefined && backup !== "") {
    try {
      if (JSON.stringify(parseSettings(backup)) === JSON.stringify(stripped)) {
        next = backup;
        how = "restoring the original from the backup, byte for byte";
      }
    } catch {
      // An unreadable backup is ignored; the structural removal stands.
    }
  }
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
  removeFile(backupPath(p.target.path));
  io.stdout(
    `Removed ${removed} Taskville hook entries from ${showPath(p.target)}. The shim copy in ${join(p.home, "hooks")} is left for any other scope that still uses it.\n`,
  );
  return EXIT.ok;
}
