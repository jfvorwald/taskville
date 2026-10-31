// Claude Code settings edits for `taskville install claude-code` (#29, ARCHITECTURE.md 8.1).
// Pure: text in, text out. File handling is in install-files.ts.
//
// Hook shape (Claude Code hooks reference, "Configuration"): settings.hooks.<Event> is a list of
// matcher groups `{ matcher?, hooks: [handler] }`. An omitted matcher matches every occurrence,
// for tool events and others alike ("Matcher patterns"). Command hooks without `args` run in
// shell form (`sh -c` on macOS and Linux), so the command is POSIX-quoted here.

/** The telemetry events of ARCHITECTURE.md 8.1. PermissionRequest is the bridge's (M4.04). */
export const HOOK_EVENTS = [
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
] as const;

/** File name of the installed shim. Distinctive, because it is how entries are recognized. */
export const SHIM_NAME = "taskville-claude-code-shim.sh";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export class SettingsError extends Error {
  override name = "SettingsError";
}

/** Single-quotes `value` for a POSIX shell: `'` becomes `'\''`. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export interface CommandParts {
  shimPath: string;
  /** Set only when it is not the default (~/.taskville). */
  home?: string | undefined;
  /** Set only when it is not the default (http://127.0.0.1:4807). */
  url?: string | undefined;
}

/** The hook command: optional variable assignments, then the shim path, all single-quoted. */
export function hookCommand(parts: CommandParts): string {
  const words: string[] = [];
  if (parts.home !== undefined) words.push(`TASKVILLE_HOME=${shellQuote(parts.home)}`);
  if (parts.url !== undefined) words.push(`TASKVILLE_URL=${shellQuote(parts.url)}`);
  words.push(shellQuote(parts.shimPath));
  return words.join(" ");
}

// Exactly the commands hookCommand produces, for any home, URL, and shim location.
const QUOTED = `'(?:[^']|'\\\\'')*'`;
const MARKER = new RegExp(
  `^(?:TASKVILLE_HOME=${QUOTED} )?(?:TASKVILLE_URL=${QUOTED} )?'(?:[^']|'\\\\'')*/${SHIM_NAME.replaceAll(".", "\\.")}'$`,
);

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** True for a hook handler this installer wrote: a command hook whose command it generated. */
export function isTaskvilleHook(handler: unknown): boolean {
  if (!isObject(handler)) return false;
  return (
    handler.type === "command" &&
    typeof handler.command === "string" &&
    MARKER.test(handler.command)
  );
}

/** Strict JSON parse of a settings file: an object whose `hooks`, if present, has the known shape. */
export function parseSettings(text: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SettingsError(`is not valid JSON (${(error as Error).message})`);
  }
  if (!isObject(value)) throw new SettingsError("is not a JSON object");
  const duplicate = duplicateKey(text);
  if (duplicate !== undefined) {
    // JSON.parse keeps only the last one, so a rewrite would silently drop data, and the diff could
    // not know an earlier value was secret (roborev 5210). The key name is not printed either.
    throw new SettingsError("has a duplicate key in one object");
  }
  if (Object.hasOwn(value, "hooks")) {
    const hooks = value.hooks;
    if (!isObject(hooks)) throw new SettingsError(`has "hooks" that is not an object`);
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) throw new SettingsError(`has hooks.${event} that is not a list`);
      for (const group of groups) {
        if (!isObject(group) || (Object.hasOwn(group, "hooks") && !Array.isArray(group.hooks))) {
          throw new SettingsError(`has a hooks.${event} entry that is not a matcher group`);
        }
      }
    }
  }
  return value;
}

/**
 * The first key that appears twice in one object of `text`, which must already be valid JSON.
 * A small scanner: strings are skipped as literals, and only object keys are compared, decoded.
 */
export function duplicateKey(text: string): string | undefined {
  const stack: { object: boolean; keys: Set<string>; expectKey: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack.at(-1);
      if (top?.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (ch === "{") stack.push({ object: true, keys: new Set(), expectKey: true });
    else if (ch === "[") stack.push({ object: false, keys: new Set(), expectKey: false });
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === ",") {
      const top = stack.at(-1);
      // Only an object's own comma means a key comes next; an array's never does.
      if (top?.object === true) top.expectKey = true;
    }
    i += 1;
  }
  return undefined;
}

/** Own-property copy that never invokes a `__proto__` setter (L-18). */
function put(obj: JsonObject, key: string, value: Json): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(obj)) Object.defineProperty(out, k, descriptor(v));
  Object.defineProperty(out, key, descriptor(value));
  return out;
}

function without(obj: JsonObject, key: string): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(obj))
    if (k !== key) Object.defineProperty(out, k, descriptor(v));
  return out;
}

const descriptor = (value: Json): PropertyDescriptor => ({
  value,
  enumerable: true,
  writable: true,
  configurable: true,
});

/**
 * Removes every handler this installer wrote. A matcher group left with no handlers is dropped,
 * then an event left with no groups, then `hooks` if it is left empty. Groups and events that held
 * only other tools' hooks are never touched.
 */
export function removeTaskvilleHooks(settings: JsonObject): {
  settings: JsonObject;
  removed: number;
} {
  if (!Object.hasOwn(settings, "hooks") || !isObject(settings.hooks))
    return { settings, removed: 0 };
  let hooks: JsonObject = settings.hooks;
  let removed = 0;
  for (const [event, groupsValue] of Object.entries(settings.hooks)) {
    const groups = groupsValue as Json[];
    let changed = false;
    const kept: Json[] = [];
    for (const group of groups) {
      const handlers = isObject(group) && Array.isArray(group.hooks) ? group.hooks : undefined;
      const mine = handlers?.filter(isTaskvilleHook).length ?? 0;
      if (handlers === undefined || mine === 0) {
        kept.push(group);
        continue;
      }
      removed += mine;
      changed = true;
      const rest = handlers.filter((h) => !isTaskvilleHook(h));
      if (rest.length > 0) kept.push(put(group as JsonObject, "hooks", rest));
    }
    if (!changed) continue;
    hooks = kept.length > 0 ? put(hooks, event, kept) : without(hooks, event);
  }
  if (removed === 0) return { settings, removed };
  const next =
    Object.keys(hooks).length > 0 ? put(settings, "hooks", hooks) : without(settings, "hooks");
  return { settings: next, removed };
}

/** Settings with exactly one Taskville handler per telemetry event, running `command`. */
export function addTaskvilleHooks(settings: JsonObject, command: string): JsonObject {
  const base = removeTaskvilleHooks(settings).settings;
  let hooks: JsonObject = Object.hasOwn(base, "hooks") && isObject(base.hooks) ? base.hooks : {};
  for (const event of HOOK_EVENTS) {
    const existing = Object.hasOwn(hooks, event) ? (hooks[event] as Json[]) : [];
    hooks = put(hooks, event, [
      ...existing,
      { hooks: [{ type: "command", command, async: true }] },
    ]);
  }
  return put(base, "hooks", hooks);
}

/** The file's indent (two spaces when it cannot tell), so a rewrite keeps its look. */
export function detectIndent(text: string): string {
  const match = /\n([ \t]+)\S/.exec(text);
  return match?.[1] ?? "  ";
}

export function serialize(settings: JsonObject, indent: string): string {
  return `${JSON.stringify(settings, null, indent)}\n`;
}
