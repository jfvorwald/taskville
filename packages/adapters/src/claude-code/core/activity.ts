import type { Activity } from "@taskville/protocol";
import { ownString } from "./fields.ts";

// Activity from tool names (ARCHITECTURE.md 8.1, 8.3). Only tools whose purpose is clear map to
// an activity; anything else leaves the activity unchanged rather than guessing. A Bash command
// that looks like a test run is a guess, so it is flagged heuristic.

export interface ToolActivity {
  activity: Activity;
  heuristic?: true;
}

const TOOL_ACTIVITIES: ReadonlyMap<string, Activity> = new Map([
  ["Edit", "implementing"],
  ["MultiEdit", "implementing"],
  ["Write", "implementing"],
  ["NotebookEdit", "implementing"],
  ["Read", "researching"],
  ["Grep", "researching"],
  ["Glob", "researching"],
  ["WebFetch", "researching"],
  ["WebSearch", "researching"],
  // Agent spawns; `Task` is the tool's earlier name.
  ["Agent", "dispatching"],
  ["Task", "dispatching"],
]);

export function activityForTool(toolName: string, toolInput: unknown): ToolActivity | undefined {
  const activity = TOOL_ACTIVITIES.get(toolName);
  if (activity !== undefined) return { activity };
  if (toolName === "Bash") {
    const command = ownString(toolInput, "command");
    if (command !== undefined && looksLikeTestRun(command)) {
      return { activity: "testing", heuristic: true };
    }
  }
  return undefined;
}

/** Only this much of a command is looked at; a test runner is named near the start. */
const COMMAND_SCAN_MAX = 4000;
const SEGMENT_MAX = 32;

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Commands that run tests whatever their arguments. */
const TEST_RUNNERS = new Set([
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "py.test",
  "rspec",
  "ava",
  "phpunit",
  "tox",
  "nox",
  "karma",
]);
/** Commands that run tests when their first argument is `test`. */
const TEST_SUBCOMMAND = new Set([
  "go",
  "cargo",
  "dotnet",
  "mvn",
  "gradle",
  "gradlew",
  "mix",
  "swift",
  "deno",
  "make",
  "bazel",
  "zig",
  "playwright",
]);
/** Prefixes that run the command after them. */
const WRAPPERS = new Set(["npx", "pnpx", "bunx", "uvx", "time", "env", "exec"]);
const WRAPPER_SUBCOMMANDS = new Set(["pnpm exec", "pnpm dlx", "yarn dlx", "uv run", "poetry run"]);

/**
 * True when some command in a shell line runs a test suite: `pnpm test`, `npx vitest`,
 * `python -m pytest`, `go test ./...`, `cd app && bun test`. A guess, never a fact.
 */
export function looksLikeTestRun(command: string): boolean {
  const segments = command.slice(0, COMMAND_SCAN_MAX).split(/&&|\|\||[;|\n]/, SEGMENT_MAX);
  return segments.some((segment) => isTestCommand(segment.trim().split(/\s+/)));
}

function isTestCommand(tokens: string[]): boolean {
  let words = tokens.filter((t) => t !== "");
  // Strip environment assignments and wrappers, a few times at most.
  for (let i = 0; i < 4; i += 1) {
    const before = words.length;
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) {
      words = words.slice(1);
    }
    if (WRAPPERS.has(words[0] ?? "")) words = words.slice(1);
    else if (WRAPPER_SUBCOMMANDS.has(`${words[0]} ${words[1]}`)) words = words.slice(2);
    if (words.length === before) break;
  }
  const head = commandName(words[0]);
  if (head === undefined) return false;
  const args = words.slice(1);
  if (TEST_RUNNERS.has(head)) return true;
  if (PACKAGE_MANAGERS.has(head)) return runsTestScript(args);
  if (TEST_SUBCOMMAND.has(head)) {
    return args[0] === "test" || (head === "make" && args[0] === "check");
  }
  if (head === "python" || head === "python3") {
    return args[0] === "-m" && (args[1] === "pytest" || args[1] === "unittest");
  }
  if (head === "node") return args.includes("--test");
  return false;
}

/** Package manager options whose value is the next word (`-C dir`, `--filter pkg`). */
const VALUE_OPTIONS = new Set([
  "-C",
  "--dir",
  "--prefix",
  "--cwd",
  "-F",
  "--filter",
  "--workspace",
]);
const isTestScript = (word: string | undefined) =>
  word !== undefined && /^test(?::\S*)?$/.test(word);

/**
 * True when the package manager's command is a `test` script: `pnpm test`, `npm run test:e2e`,
 * `pnpm -C app test`, `yarn workspace web test`. Options and their values are skipped, so a
 * directory or package named `test` is not a test run.
 */
function runsTestScript(args: string[]): boolean {
  const positional: string[] = [];
  for (let i = 0; i < args.length && positional.length < 4; i += 1) {
    const word = args[i] as string;
    if (word === "--") break;
    if (word.startsWith("-")) {
      if (VALUE_OPTIONS.has(word)) i += 1;
      continue;
    }
    positional.push(word);
  }
  return isTestInvocation(positional);
}

/** `test`, `run test`, or either after `workspace <name>`. */
function isTestInvocation(positional: string[]): boolean {
  const [command, second] = positional;
  if (isTestScript(command)) return true;
  if (command === "run" || command === "run-script") return isTestScript(second);
  if (command === "workspace") return isTestInvocation(positional.slice(2));
  return false;
}

/** `./gradlew` -> `gradlew`, `node_modules/.bin/vitest` -> `vitest`. */
function commandName(word: string | undefined): string | undefined {
  if (word === undefined || word === "") return undefined;
  return word.slice(word.lastIndexOf("/") + 1);
}
