// Live run of the Claude Code telemetry end-to-end check (M2.10). Uses a real model, so it is not
// part of `pnpm check` or the replay test. Usage:
//
//   node tests/e2e/claude-code-telemetry/live.ts --out <scratch dir> [--model claude-haiku-5-5]
//
// Everything lives under --out: a throwaway git project, a TASKVILLE_HOME, the recordings, and
// the report. `taskville install claude-code --scope project` writes into the throwaway project
// only; every `claude` run uses `--setting-sources project,local` and a clean environment, so no
// user hooks or plugins fire. The one side effect outside --out: the interactive team run adds a
// folder-trust entry for the throwaway project to ~/.claude.json.
//
// A second, synchronous recorder hook (project settings) writes every raw hook payload with its
// receive time, because async hooks that fire as a `claude -p` process exits (its final Stop) are
// not run; the recordings become the replay fixtures after `redact.ts`.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openEvidenceStore } from "../../../apps/engine/src/evidence/index.ts";
import {
  agentIdOf,
  cli,
  type Engine,
  freePort,
  isMasked,
  logEvents,
  loggedToolCalls,
  REPO,
  snapshot,
  startEngine,
} from "./harness.ts";
import { FAKE_TOKEN } from "./redact.ts";

const { values } = parseArgs({
  options: { out: { type: "string" }, model: { type: "string" }, only: { type: "string" } },
});
if (values.out === undefined) throw new Error("--out <dir> is required");
const OUT = resolve(values.out);
const MODEL = values.model ?? "claude-haiku-5-5";
const PROJ = join(OUT, "proj");
const HOME = join(OUT, "home");
const RAW = join(OUT, "raw");
const REC = join(OUT, "rec.jsonl");
const PROJECT_ID = "e2e";

const report: string[] = [];
const say = (line: string) => {
  report.push(line);
  console.log(line);
};

// --- Setup -------------------------------------------------------------------------------------

function setup(): void {
  for (const dir of [OUT, PROJ, RAW]) mkdirSync(dir, { recursive: true });
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(join(PROJ, "notes.txt"), "line one\nline two\n");
  writeFileSync(join(PROJ, "README.md"), "# e2e\n");
  const git = (...args: string[]) => spawnSync("git", args, { cwd: PROJ, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-qm", "init");
  // Synchronous recorder for every hook, including ones Taskville does not install.
  const recorder = join(OUT, "rec.py");
  writeFileSync(
    recorder,
    [
      "import json, os, sys, time",
      "data = sys.stdin.buffer.read()",
      "t = time.time() * 1000.0",
      "try:",
      "    payload = json.loads(data)",
      "except Exception:",
      '    payload = {"_unparsed": data.decode("utf-8", "replace")}',
      'line = json.dumps({"t_ms": t, "input": payload}, separators=(",", ":")) + "\\n"',
      "fd = os.open(sys.argv[1], os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)",
      'os.write(fd, line.encode("utf-8"))',
      "os.close(fd)",
    ].join("\n"),
  );
  const events = [
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
    "PermissionRequest",
    "PermissionDenied",
  ];
  const q = (w: string) => `'${w.replaceAll("'", "'\\''")}'`;
  const command = `/usr/bin/python3 ${q(recorder)} ${q(REC)}`;
  const hooks = Object.fromEntries(
    events.map((e) => [e, [{ hooks: [{ type: "command", command }] }]]),
  );
  mkdirSync(join(PROJ, ".claude"), { recursive: true });
  writeFileSync(join(PROJ, ".claude", "settings.json"), `${JSON.stringify({ hooks }, null, 2)}\n`);
  writeFileSync(
    join(PROJ, ".mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          elic: {
            command: process.execPath,
            args: [join(REPO, "tests/e2e/claude-code-telemetry/elicit-server.mjs")],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function claudeEnv(extra: Record<string, string> = {}): Record<string, string> {
  // Clean environment: nothing from the session that runs this script.
  return {
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
    LOGNAME: process.env.LOGNAME ?? "",
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    TERM: "xterm-256color",
    ...extra,
  };
}

function runPrint(
  prompt: string,
  flags: string[],
  env: Record<string, string> = {},
): Promise<string> {
  return new Promise((done) => {
    const child = spawn(
      "claude",
      ["-p", prompt, "--model", MODEL, "--setting-sources", "project,local", ...flags],
      { cwd: PROJ, env: claudeEnv(env), stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.on("exit", () => done(out));
  });
}

interface RecLine {
  t_ms: number;
  input: Record<string, unknown>;
}

function recorded(): RecLine[] {
  if (!existsSync(REC)) return [];
  return readFileSync(REC, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as RecLine);
}

/** Moves the recording to raw/<name>.jsonl in the fixture format: `{seq, offset_ms, input}`. */
function saveRecording(name: string): RecLine[] {
  const lines = recorded().sort((a, b) => a.t_ms - b.t_ms);
  const t0 = lines[0]?.t_ms ?? 0;
  const text = lines
    .map((l, seq) =>
      JSON.stringify({ seq, offset_ms: Math.round((l.t_ms - t0) * 10) / 10, input: l.input }),
    )
    .join("\n");
  writeFileSync(join(RAW, `${name}.jsonl`), lines.length === 0 ? "" : `${text}\n`);
  if (existsSync(REC)) renameSync(REC, join(OUT, `rec-${name}.done`));
  return lines;
}

// --- Measuring ---------------------------------------------------------------------------------

/** Polls the snapshot every 100 ms and notes when each agent first appears (epoch ms). */
function poller(engineRef: () => Engine | undefined) {
  const firstSeen = new Map<string, number>();
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const engine = engineRef();
      if (engine !== undefined) {
        try {
          const snap = await snapshot(engine, PROJECT_ID);
          const now = Date.now();
          for (const id of Object.keys(snap.state.agents))
            if (!firstSeen.has(id)) firstSeen.set(id, now);
        } catch {
          // Engine down (the downtime scenario) or starting.
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  return {
    firstSeen,
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

function latencies(lines: RecLine[], firstSeen: Map<string, number>): void {
  const firstHook = new Map<string, { t: number; event: string }>();
  for (const l of lines) {
    const id = agentIdOf(l.input);
    if (!firstHook.has(id))
      firstHook.set(id, { t: l.t_ms, event: String(l.input.hook_event_name) });
  }
  for (const [id, { t, event }] of firstHook) {
    const seen = firstSeen.get(id);
    say(
      seen === undefined
        ? `  agent ${id}: first hook ${event}, never in the snapshot`
        : `  agent ${id}: first hook ${event}, in the snapshot after ${Math.max(0, Math.round(seen - t))} ms`,
    );
  }
}

function counts(lines: RecLine[]): string {
  const c = new Map<string, number>();
  for (const l of lines) {
    const name = String(l.input.hook_event_name);
    c.set(name, (c.get(name) ?? 0) + 1);
  }
  return [...c].map(([k, v]) => `${k} ${v}`).join(", ");
}

async function status(engine: Engine): Promise<void> {
  const base = ["--project", PROJECT_ID, "--home", HOME, "--url", engine.url];
  const tree = await cli(["status", ...base, "--all"]);
  say("  taskville status --all:");
  for (const row of tree.stdout.trimEnd().split("\n")) say(`    ${row}`);
  const json = await cli(["status", ...base, "--all", "--json"]);
  writeFileSync(join(OUT, `status-${Date.now()}.json`), json.stdout);
}

function evidenceCheck(lines: RecLine[]): void {
  const hooks = new Set(
    lines
      .filter((l) =>
        ["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(
          String(l.input.hook_event_name),
        ),
      )
      .map((l) => String(l.input.tool_use_id)),
  );
  const logged = loggedToolCalls(HOME, PROJECT_ID);
  const missing = [...hooks].filter((id) => !logged.has(id));
  const store = openEvidenceStore(join(HOME, "evidence.db"));
  try {
    let withBodies = 0;
    let leaked = 0;
    let masked = 0;
    for (const id of hooks) {
      const ev = store.get(PROJECT_ID, id);
      if (ev === undefined) continue;
      withBodies += 1;
      const text = JSON.stringify(ev);
      if (text.includes(FAKE_TOKEN)) leaked += 1;
      if (isMasked(ev.input) || isMasked(ev.output)) masked += 1;
    }
    say(
      `  tool calls in the hooks ${hooks.size}, in the event log ${logged.size} (missing ${missing.length}), with evidence bodies ${withBodies}, bodies marked masked ${masked}, bodies holding the seeded token unmasked ${leaked}`,
    );
  } finally {
    store.close();
  }
}

// --- Scenarios ---------------------------------------------------------------------------------

const ALLOWED = ["--allowedTools", "Bash Read Edit Write Agent TaskCreate TaskUpdate TaskList"];

async function subagents(ref: { engine?: Engine | undefined }): Promise<void> {
  say(
    "scenario subagents (claude -p): two subagents, tool calls, a seeded token, tasks, a failure",
  );
  const prompt = [
    "Do exactly these steps in order, then reply with the single word done.",
    "1. In ONE message, launch two subagents with the Agent tool (subagent_type general-purpose, foreground):",
    `the first runs the Bash command \`echo token ${FAKE_TOKEN}\` and reports what it printed;`,
    "the second reads notes.txt with the Read tool and reports how many lines it has.",
    "2. Use the TaskCreate tool to create a task with subject 'e2e check', then use TaskUpdate to mark it completed.",
    "3. Run the Bash command `cat missing-file.txt` (it will fail; that is expected).",
    "4. Use the Edit tool to change 'line two' to 'line two (edited)' in notes.txt.",
  ].join("\n");
  const watch = poller(() => ref.engine);
  const out = await runPrint(prompt, ALLOWED);
  await new Promise((r) => setTimeout(r, 2000));
  await watch.stop();
  const lines = saveRecording("subagents");
  say(`  claude said: ${out.trim().slice(-80)}`);
  say(`  hooks: ${counts(lines)}`);
  latencies(lines, watch.firstSeen);
  if (ref.engine) await status(ref.engine);
  evidenceCheck(lines);
}

async function downtime(ref: { engine?: Engine | undefined }, port: number): Promise<void> {
  say("scenario downtime (claude -p): the engine is killed mid-session and restarted after it");
  const prompt = [
    "Run these Bash commands one at a time, each as its own tool call, in this order:",
    "`echo step1`, `sleep 3`, `echo step2`, `sleep 3`, `echo step3`. Then reply with the single word done.",
  ].join("\n");
  const before = ref.engine ? (await snapshot(ref.engine, PROJECT_ID)).cursor : 0;
  const running = runPrint(prompt, ALLOWED);
  let killedAt = 0;
  for (let i = 0; i < 600 && killedAt === 0; i++) {
    const hit = recorded().some(
      (l) =>
        l.input.hook_event_name === "PostToolUse" &&
        JSON.stringify(l.input.tool_input ?? {}).includes("echo step1"),
    );
    if (hit && ref.engine) {
      await ref.engine.kill();
      ref.engine = undefined;
      killedAt = Date.now();
      say("  engine killed (SIGKILL) after the PostToolUse of `echo step1`");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await running;
  if (killedAt === 0)
    throw new Error(
      "downtime: the `echo step1` PostToolUse never arrived; the engine was not killed",
    );
  await new Promise((r) => setTimeout(r, 2000));
  const spooled = readdirSync(join(HOME, "spool")).filter((n) => n.endsWith(".jsonl"));
  const spoolLines = spooled
    .map(
      (n) =>
        readFileSync(join(HOME, "spool", n), "utf8")
          .split("\n")
          .filter((l) => l !== "").length,
    )
    .reduce((a, b) => a + b, 0);
  say(`  while down: ${spoolLines} spool lines in ${spooled.join(", ") || "no file"}`);
  ref.engine = await startEngine(HOME, port);
  const snap = await snapshot(ref.engine, PROJECT_ID);
  const replayed =
    ref.engine
      .log()
      .split("\n")
      .find((l) => l.includes("spool replayed")) ?? "(no replay log line)";
  say(
    `  restarted: cursor ${before} before the run, ${snap.cursor} after replay; ${replayed.slice(0, 300)}`,
  );
  say(`  spool after restart: ${readdirSync(join(HOME, "spool")).join(", ") || "empty"}`);
  say(`  needs-you records: ${snap.attention.filter((a) => a.level === "needs_you").length}`);
  const late = logEvents(HOME, PROJECT_ID).filter((e) => e.late);
  say(
    `  late events in the log: ${late.length} (${[...new Set(late.map((e) => e.type))].join(", ")})`,
  );
  const lines = saveRecording("downtime");
  say(`  hooks: ${counts(lines)}`);
  evidenceCheck(lines);
  await status(ref.engine);
}

function tmux(...args: string[]): string {
  return spawnSync("tmux", ["-L", "taskville-e2e", ...args], { encoding: "utf8" }).stdout ?? "";
}

async function waitFor(test: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (test()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function team(ref: { engine?: Engine | undefined }): Promise<void> {
  say("scenario team (interactive, tmux, in-process): one teammate, a task, then shutdown");
  const env = claudeEnv({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" });
  const envArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const command = [
    "env",
    "-i",
    ...envArgs,
    "claude",
    "--model",
    MODEL,
    "--setting-sources",
    "project,local",
    "--teammate-mode",
    "in-process",
    ...ALLOWED,
  ]
    .map((w) => `'${w.replaceAll("'", "'\\''")}'`)
    .join(" ");
  tmux("kill-server");
  tmux("new-session", "-d", "-x", "220", "-y", "50", "-c", PROJ, command);
  const watch = poller(() => ref.engine);
  // The folder-trust dialog (the accepted side effect: an entry in ~/.claude.json). Its default
  // is "No, exit", so move to "Yes, I trust this folder" first.
  // The dialog ignores keys until it has settled, so check that the selection moved before Enter.
  if (await waitFor(() => /trust this folder/i.test(tmux("capture-pane", "-p")), 20_000)) {
    const selected = () => /❯ Yes, I trust this folder/.test(tmux("capture-pane", "-p"));
    for (let i = 0; i < 10 && !selected(); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      tmux("send-keys", "Down");
    }
    await new Promise((r) => setTimeout(r, 500));
    if (selected()) {
      tmux("send-keys", "Enter");
      say("  accepted the folder-trust dialog for the throwaway project");
    }
  }
  // The project's MCP server prompt: the default, "Continue without using this MCP server", is fine.
  if (await waitFor(() => /New MCP server found/i.test(tmux("capture-pane", "-p")), 10_000)) {
    await new Promise((r) => setTimeout(r, 1000));
    tmux("send-keys", "Enter");
  }
  await waitFor(() => /Claude Code v/.test(tmux("capture-pane", "-p")), 20_000);
  await waitFor(() => recorded().some((l) => l.input.hook_event_name === "SessionStart"), 20_000);
  await new Promise((r) => setTimeout(r, 2000));
  const prompt =
    "Create an agent team with exactly one teammate named pip. First use TaskCreate to add a task 'pip says hi' and assign it to pip. Ask pip to run the Bash command `echo hi-from-pip`, mark the task completed, and report back. When pip has reported, shut the team down and reply done. Keep everything short.";
  tmux("send-keys", "-l", prompt);
  tmux("send-keys", "Enter");
  const idle = await waitFor(
    () => recorded().some((l) => l.input.hook_event_name === "TeammateIdle"),
    240_000,
  );
  say(`  TeammateIdle ${idle ? "seen" : "not seen within 240 s"}`);
  if (!idle) {
    // Do not save an incomplete run: redaction would overwrite the committed team fixture with it.
    tmux("kill-server");
    await watch.stop();
    throw new Error("team scenario: no TeammateIdle within 240 s; recording not saved");
  }
  // Let the lead finish its shutdown turn.
  await waitFor(() => {
    const lines = recorded();
    const last = lines[lines.length - 1];
    return last !== undefined && Date.now() - last.t_ms > 15_000;
  }, 240_000);
  tmux("send-keys", "/exit");
  tmux("send-keys", "Enter");
  const ended = await waitFor(
    () => recorded().some((l) => l.input.hook_event_name === "SessionEnd"),
    30_000,
  );
  if (!ended) {
    tmux("kill-server");
    await watch.stop();
    throw new Error("team scenario: no SessionEnd within 30 s of /exit; recording not saved");
  }
  await new Promise((r) => setTimeout(r, 2000));
  writeFileSync(join(OUT, "team-pane.txt"), tmux("capture-pane", "-p", "-S", "-200"));
  tmux("kill-server");
  await watch.stop();
  const lines = saveRecording("team");
  say(`  hooks: ${counts(lines)}`);
  latencies(lines, watch.firstSeen);
  evidenceCheck(lines);
  if (ref.engine) await status(ref.engine);
}

async function stopFailure(): Promise<void> {
  say("scenario stop-failure (claude -p, unknown model): StopFailure");
  const out = await new Promise<string>((done) => {
    const child = spawn(
      "claude",
      ["-p", "hi", "--model", "claude-nonexistent-0-0", "--setting-sources", "project,local"],
      { cwd: PROJ, env: claudeEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let text = "";
    child.stdout.on("data", (c: Buffer) => {
      text += c.toString("utf8");
    });
    child.on("exit", () => done(text));
  });
  await new Promise((r) => setTimeout(r, 1500));
  const lines = saveRecording("stop-failure");
  say(`  claude said: ${out.trim().slice(0, 100)}`);
  say(`  hooks: ${counts(lines)}`);
}

async function elicitation(): Promise<void> {
  say("scenario elicitation (claude -p, stdio MCP server): Elicitation");
  const out = await runPrint(
    "Call the ask_name tool once, then reply with exactly what it returned.",
    ["--allowedTools", "mcp__elic__ask_name", "--permission-prompts", "none"],
  );
  await new Promise((r) => setTimeout(r, 1500));
  const lines = saveRecording("elicitation");
  say(`  claude said: ${out.trim().slice(-120)}`);
  say(`  hooks: ${counts(lines)}`);
}

// --- Main --------------------------------------------------------------------------------------

async function main(): Promise<void> {
  setup();
  const version = spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout.trim();
  say(`Claude Code ${version}, model ${MODEL}, ${new Date().toISOString()}`);
  const port = await freePort();
  const ref: { engine?: Engine | undefined } = { engine: await startEngine(HOME, port) };
  const engine = ref.engine as Engine;
  const add = await cli([
    "project",
    "add",
    "--name",
    "e2e",
    "--id",
    PROJECT_ID,
    "--root",
    PROJ,
    "--home",
    HOME,
    "--url",
    engine.url,
  ]);
  say(`project add: ${add.stdout.trim()}`);
  const install = await cli([
    "install",
    "claude-code",
    "--scope",
    "project",
    "--project-dir",
    PROJ,
    "--home",
    HOME,
    "--url",
    engine.url,
    "--yes",
  ]);
  say(`install: ${install.stdout.trim().split("\n").pop()}`);
  const only = values.only?.split(",");
  const want = (name: string) => only === undefined || only.includes(name);
  try {
    if (want("subagents")) await subagents(ref);
    if (want("downtime")) await downtime(ref, port);
    if (want("team")) await team(ref);
    if (want("stop-failure")) await stopFailure();
    if (want("elicitation")) await elicitation();
  } finally {
    await ref.engine?.stop();
    writeFileSync(join(OUT, "report.txt"), `${report.join("\n")}\n`);
  }
}

await main();
