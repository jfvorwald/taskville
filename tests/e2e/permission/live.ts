// Live run of the permission end-to-end check (M4.10, #69). NOT RUN until the owner chooses
// (decision #289): it starts a real interactive `claude`, and the folder-trust dialog of a new
// folder writes a trust entry into ~/.claude.json. Uses a real model, so it is not part of
// `pnpm check` or the replay spec. Usage:
//
//   pnpm --filter @taskville/web build
//   node tests/e2e/permission/live.ts --out <scratch dir> [--model claude-haiku-5-5] [--only allow,deny,terminal]
//
// Everything lives under --out: a throwaway git project (`proj`, registered with no Taskville
// project, so the engine files the session under `unsorted`, the project the client shows), a
// TASKVILLE_HOME (`home`), the pane captures, and the report. `taskville install claude-code
// --scope project` writes into the throwaway project only; `claude` runs with
// `--setting-sources project,local` in a private tmux server.
//
// Scenarios, each one fresh interactive session that is asked to run one Bash command:
//   allow     the city answers Allow once on the card; the file the command creates must exist.
//   deny      the city answers Deny with a note; the file must not exist and the note must reach
//             Claude Code (it shows in the pane).
//   terminal  no viewer is connected: the terminal dialog must appear, and answering Yes there
//             runs the command.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cli } from "../claude-code-telemetry/harness.ts";
import { eventsOfType, type PermissionEngine, startPermissionEngine } from "./harness.ts";
import { chromium, type Page } from "./playwright.ts";

const { values } = parseArgs({
  options: { out: { type: "string" }, model: { type: "string" }, only: { type: "string" } },
});
if (values.out === undefined) throw new Error("--out <dir> is required");
const OUT = resolve(values.out);
const MODEL = values.model ?? "claude-haiku-5-5";
const PROJ = join(OUT, "proj");
const HOME = join(OUT, "home");
const TMUX = "taskville-permission-e2e";
const DENY_NOTE = "TASKVILLE-E2E-DENY-4K: the owner said no, do not retry";

const report: string[] = [];
const say = (line: string) => {
  report.push(line);
  console.log(line);
};
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  say(`  ${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(
  test: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await test()) return true;
    await sleep(500);
  }
  return false;
}

// --- tmux and claude ---------------------------------------------------------------------------

function tmux(...args: string[]): string {
  return spawnSync("tmux", ["-L", TMUX, ...args], { encoding: "utf8" }).stdout ?? "";
}
const pane = () => tmux("capture-pane", "-p", "-S", "-200");

function claudeEnv(): Record<string, string> {
  // Clean environment: nothing from the session that runs this script. HOME stays the real one,
  // because that is where Claude Code finds its login.
  return {
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
    LOGNAME: process.env.LOGNAME ?? "",
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    TERM: "xterm-256color",
  };
}

/** Starts an interactive `claude` in the private tmux server and gets past the trust dialog. */
async function startClaude(): Promise<void> {
  const env = Object.entries(claudeEnv()).map(([k, v]) => `${k}=${v}`);
  const command = [
    "env",
    "-i",
    ...env,
    "claude",
    "--model",
    MODEL,
    "--setting-sources",
    "project,local",
  ]
    .map((w) => `'${w.replaceAll("'", "'\\''")}'`)
    .join(" ");
  tmux("kill-server");
  tmux("new-session", "-d", "-x", "200", "-y", "50", "-c", PROJ, command);
  // The folder-trust dialog (the side effect decision #289 is about: an entry in ~/.claude.json).
  // Its default is "No, exit", so move to "Yes, I trust this folder" first.
  if (await waitFor(() => /trust this folder/i.test(pane()), 20_000)) {
    const selected = () => /❯ Yes, I trust this folder/.test(pane());
    for (let i = 0; i < 10 && !selected(); i++) {
      await sleep(1000);
      tmux("send-keys", "Down");
    }
    await sleep(500);
    if (selected()) tmux("send-keys", "Enter");
  }
  await waitFor(() => /Claude Code v/.test(pane()), 20_000);
  await sleep(2000);
}

function ask(command: string): void {
  tmux(
    "send-keys",
    "-l",
    `Use the Bash tool to run exactly: ${command}   Then reply with the single word done.`,
  );
  tmux("send-keys", "Enter");
}

function stopClaude(label: string): void {
  writeFileSync(join(OUT, `pane-${label}.txt`), pane());
  tmux("send-keys", "/exit");
  tmux("send-keys", "Enter");
  tmux("kill-server");
}

// --- the city ----------------------------------------------------------------------------------

async function openCity(engine: PermissionEngine): Promise<{ page: Page; close(): Promise<void> }> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await (await browser.newContext({ baseURL: engine.url })).newPage();
  await page.goto(`/#pair=${engine.pairingCode}`);
  await page.getByTestId("scene-root").waitFor({ timeout: 20_000 });
  return { page, close: () => browser.close() };
}

/** Waits for the red agent of the live session, selects it, and returns the open card. */
async function openRedCard(page: Page) {
  const row = page.getByTestId("agent-list").locator('[data-urgent="true"]').first();
  await row.waitFor({ timeout: 90_000 });
  await row.click();
  const card = page.getByTestId("action-card");
  await card.waitFor({ timeout: 10_000 });
  return card;
}

// --- scenarios ---------------------------------------------------------------------------------

async function allow(engine: PermissionEngine, page: Page): Promise<void> {
  say("scenario allow: Allow once from the card lets the tool run");
  const file = join(PROJ, "allowed.txt");
  await startClaude();
  ask("touch allowed.txt");
  const card = await openRedCard(page);
  check(
    (await card.textContent())?.includes("touch allowed.txt") === true,
    "the card shows the exact command",
  );
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  check(
    await waitFor(async () => (await card.getAttribute("data-state")) === "sent", 10_000),
    "the card says Sent, unconfirmed",
  );
  check(await waitFor(() => existsSync(file), 60_000), "the tool ran: allowed.txt exists");
  check(
    eventsOfType(engine.home, "command.delivered").length >= 1,
    "the engine recorded a delivered command",
  );
  stopClaude("allow");
}

async function deny(page: Page): Promise<void> {
  say("scenario deny: Deny with a note blocks the tool and the note reaches Claude Code");
  const file = join(PROJ, "denied.txt");
  await startClaude();
  ask("touch denied.txt");
  const card = await openRedCard(page);
  await page.getByRole("textbox", { name: /note/i }).fill(DENY_NOTE);
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  check(
    await waitFor(async () => (await card.getAttribute("data-state")) === "sent", 10_000),
    "the card says Sent, unconfirmed",
  );
  check(
    await waitFor(() => pane().includes("TASKVILLE-E2E-DENY-4K"), 60_000),
    "the note reached Claude Code (it is in the pane)",
  );
  check(!existsSync(file), "the tool was blocked: denied.txt does not exist");
  stopClaude("deny");
}

async function terminal(): Promise<void> {
  say(
    "scenario terminal: no viewer connected, so the terminal dialog appears and Yes runs the tool",
  );
  const file = join(PROJ, "terminal.txt");
  await startClaude();
  ask("touch terminal.txt");
  check(
    await waitFor(() => /Do you want to proceed\?/.test(pane()), 60_000),
    "the terminal permission dialog appeared",
  );
  tmux("send-keys", "Enter"); // "1. Yes" is the default choice
  check(
    await waitFor(() => existsSync(file), 60_000),
    "answering Yes in the terminal ran the tool",
  );
  stopClaude("terminal");
}

// --- main --------------------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(PROJ, { recursive: true });
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(join(PROJ, "README.md"), "# permission e2e\n");
  const git = (...args: string[]) => spawnSync("git", args, { cwd: PROJ, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-qm", "init");

  const version = spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout.trim();
  say(`Claude Code ${version}, model ${MODEL}, ${new Date().toISOString()}`);

  const engine = await startPermissionEngine(90, { root: OUT, keepRoot: true });
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
  const city = want("allow") || want("deny") ? await openCity(engine) : undefined;
  try {
    if (city && want("allow")) await allow(engine, city.page);
    if (city && want("deny")) await deny(city.page);
    // The terminal scenario needs no viewer: close the browser first.
    await city?.close();
    if (want("terminal")) await terminal();
  } finally {
    tmux("kill-server");
    await engine.stop();
    writeFileSync(join(OUT, "report.txt"), `${report.join("\n")}\n`);
  }
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed`);
    process.exitCode = 1;
  }
}

await main();
