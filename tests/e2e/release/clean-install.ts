// M7.28 (#427): the clean-machine install check for a release tarball (S-3 option C part 2).
//
// NOT a vitest or Playwright test runner spec: a plain node script that drives the real artifact, so
// a missing file in the tarball, a path that only works from a checkout, or a command that needs the
// repo on PATH fails here and nowhere else. It never imports Taskville source.
//
//   pnpm test:release:install <release-dir> --receipt <receipt.json> [--keep-temp]
//   node tests/e2e/release/clean-install.ts <release-dir> --receipt <receipt.json>
//
// <release-dir> is what `pnpm release --out <dir>` wrote: `<id>/` holding taskville-<version>.tgz,
// release.json and manifest.json (pass `<dir>/<id>`; a parent holding exactly one release also works).
//
// Isolation: a fresh temp HOME, TASKVILLE_HOME and npm cache; PATH is the node directory, the
// install's bin, /usr/bin and /bin only; every child runs with a cwd outside the repository and an
// environment built from scratch (nothing inherited, so no TASKVILLE_*, CLAUDE_* or npm_config_*).
// The real ~/.claude, ~/.codex, ~/.claude.json and ~/.taskville are never read or written: `init`
// only writes project-scope hooks inside the throwaway git repo and the shim inside the temp home.
//
// Steps run in order; a step whose prerequisite failed is "skipped". The receipt is written even if
// the run crashes, and the exit code is non-zero unless every step passed.

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";

const HARNESS_REPO = resolve(import.meta.dirname, "../../..");
const HOOK_FIXTURE = join(HARNESS_REPO, "fixtures/claude-code/subagent/parallel.jsonl");
/** The seeded demo always creates these six agents (see tests/e2e/web/support.ts). */
const DEMO_AGENTS = ["Ada", "Brook", "Cyd", "Dee", "Eli", "Fay"];

type Status = "pass" | "fail" | "skipped";
interface StepResult {
  id: string;
  title: string;
  status: Status;
  durationMs: number;
  detail?: string;
  error?: string;
}

interface Manifest {
  id: string;
  version: string;
  environment: string;
  release: { sha256: string };
  tarball: { sha256: string };
}

// ---------------------------------------------------------------------------------------------
// Arguments

function usage(message: string): never {
  console.error(`${message}\nUsage: clean-install.ts <release-dir> --receipt <file> [--keep-temp]`);
  process.exit(2);
}

function parseArgs(argv: string[]): { releaseDir: string; receipt: string; keepTemp: boolean } {
  let releaseDir: string | undefined;
  let receipt: string | undefined;
  let keepTemp = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--receipt") {
      receipt = argv[++i];
      if (receipt === undefined || receipt.startsWith("--")) usage("--receipt needs a path");
    } else if (arg === "--keep-temp") keepTemp = true;
    else if (arg.startsWith("--")) usage(`unknown option ${arg}`);
    else if (releaseDir === undefined) releaseDir = arg;
    else usage("only one release directory is accepted");
  }
  if (releaseDir === undefined) usage("a release directory is required");
  if (receipt === undefined) usage("--receipt <file> is required");
  return {
    releaseDir: resolve(releaseDir as string),
    receipt: resolve(receipt as string),
    keepTemp,
  };
}

/** `dir` itself when it holds manifest.json, else its only child that does. */
function locateRelease(dir: string): string {
  if (existsSync(join(dir, "manifest.json"))) return dir;
  const children = existsSync(dir)
    ? readdirSync(dir).filter((n) => existsSync(join(dir, n, "manifest.json")))
    : [];
  if (children.length !== 1) {
    usage(
      `${dir} is not a release directory (no manifest.json, and not exactly one release in it)`,
    );
  }
  return join(dir, children[0] as string);
}

// ---------------------------------------------------------------------------------------------
// Process helpers

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs?: number },
): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`${command} ${args.join(" ")} timed out\n${tail(stdout + stderr)}`));
    }, options.timeoutMs ?? 120_000);
    child.once("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}

const tail = (text: string, lines = 15) => text.trimEnd().split("\n").slice(-lines).join("\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined> | T | undefined,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(200);
  }
}

// ---------------------------------------------------------------------------------------------
// The run

const args = parseArgs(process.argv.slice(2));
const releaseDir = locateRelease(args.releaseDir);
const manifest = JSON.parse(readFileSync(join(releaseDir, "manifest.json"), "utf8")) as Manifest;
const tarball = join(releaseDir, `taskville-${manifest.version}.tgz`);
const shortId = manifest.id.slice(0, 12); // the header badge shows the first 12 characters

const root = realpathSync(mkdtempSync(join(tmpdir(), "taskville-clean-install-")));
const dirs = {
  home: join(root, "home"),
  taskvilleHome: join(root, "taskville-home"),
  npmCache: join(root, "npm-cache"),
  prefix: join(root, "prefix"),
  work: join(root, "work"),
  repo: join(root, "project"),
};
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
const bin = join(dirs.prefix, "node_modules/.bin");

/** Built from scratch: nothing from the caller's environment leaks into the install under test. */
const env: NodeJS.ProcessEnv = {
  HOME: dirs.home,
  TASKVILLE_HOME: dirs.taskvilleHome,
  PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
  npm_config_cache: dirs.npmCache,
  npm_config_userconfig: join(dirs.home, ".npmrc"),
  npm_config_update_notifier: "false",
  TMPDIR: tmpdir(),
  LANG: "C.UTF-8",
  GIT_CONFIG_GLOBAL: join(dirs.home, ".gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
};

const results: StepResult[] = [];
const failed = new Set<string>();
let engine: ChildProcess | undefined;
let engineOut = "";
let engineErr = "";
// biome-ignore lint/suspicious/noExplicitAny: Playwright is loaded dynamically (see launchChromium).
let browser: any;
// biome-ignore lint/suspicious/noExplicitAny: same.
let page: any;
const pageErrors: string[] = [];
let base = "";
let projectId = "";

async function step(
  id: string,
  title: string,
  needs: string[],
  body: () => Promise<string | undefined>,
): Promise<void> {
  const blocker = needs.find((n) => failed.has(n));
  if (blocker !== undefined) {
    failed.add(id);
    results.push({ id, title, status: "skipped", durationMs: 0, detail: `needs ${blocker}` });
    console.log(`SKIP ${id}: ${title} (needs ${blocker})`);
    return;
  }
  const started = Date.now();
  try {
    const detail = await body();
    const durationMs = Date.now() - started;
    results.push({ id, title, status: "pass", durationMs, ...(detail ? { detail } : {}) });
    console.log(`PASS ${id}: ${title} (${durationMs} ms)`);
  } catch (error) {
    failed.add(id);
    const durationMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    results.push({ id, title, status: "fail", durationMs, error: message });
    console.log(`FAIL ${id}: ${title} (${durationMs} ms)\n${message}\n`);
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const taskville = (a: string[], extra: { cwd?: string; input?: string; timeoutMs?: number } = {}) =>
  run(join(bin, "taskville"), a, { cwd: extra.cwd ?? dirs.work, env, ...extra });

const engineToken = () => readFileSync(join(dirs.taskvilleHome, "token"), "utf8").trim();
async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${engineToken()}` },
  });
  if (res.status !== 200) throw new Error(`GET ${path} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}
interface Snapshot {
  state: { agents: Record<string, { id: string; kind: string; displayName?: string }> };
}
const snapshotOf = (project: string) => api<Snapshot>(`/v1/projects/${project}/snapshot`);

async function launchChromium() {
  // A clean runner installs `playwright` next to the harness; a checkout has it under apps/web.
  const specifier = "playwright";
  try {
    return (await import(specifier)).chromium;
  } catch {
    return (await import("../web/playwright.ts")).chromium;
  }
}

async function main(): Promise<void> {
  await step("isolation", "the environment is clean and outside the repository", [], async () => {
    const inside = (p: string) => p === HARNESS_REPO || p.startsWith(HARNESS_REPO + sep);
    const offenders = (env.PATH ?? "").split(delimiter).filter((p) => p !== bin && inside(p));
    expect(offenders.length === 0, `PATH entries inside the repository: ${offenders.join(", ")}`);
    expect(!inside(root), `temp root ${root} is inside the repository`);
    expect(dirs.home !== homedir(), "HOME is the real home");
    return `root ${root}`;
  });

  await step("verify-tarball", "the tarball matches manifest.json", [], async () => {
    expect(existsSync(tarball), `${tarball} is missing`);
    const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    expect(
      actual === manifest.tarball.sha256,
      `tarball sha256 ${actual} != manifest ${manifest.tarball.sha256}`,
    );
    const releaseJson = createHash("sha256")
      .update(readFileSync(join(releaseDir, "release.json")))
      .digest("hex");
    expect(
      releaseJson === manifest.release.sha256,
      `release.json sha256 ${releaseJson} != manifest ${manifest.release.sha256}`,
    );
    tarballSha256 = actual;
    return actual;
  });

  await step(
    "install",
    "npm install --prefix <tmp> <tgz> --offline",
    ["verify-tarball"],
    async () => {
      const r = await run(
        "npm",
        ["install", "--prefix", dirs.prefix, tarball, "--offline", "--no-audit", "--no-fund"],
        { cwd: dirs.work, env, timeoutMs: 180_000 },
      );
      expect(r.code === 0, `npm install exited ${r.code}\n${tail(r.stdout + r.stderr)}`);
      expect(existsSync(join(bin, "taskville")), `npm install left no ${join(bin, "taskville")}`);
      return undefined;
    },
  );

  await step(
    "version",
    "taskville --version prints the version and release id",
    ["install"],
    async () => {
      const r = await taskville(["--version"]);
      const want = `taskville ${manifest.version} (${manifest.id})`;
      expect(r.code === 0, `exited ${r.code}\n${tail(r.stdout + r.stderr)}`);
      expect(
        r.stdout.trim() === want,
        `printed ${JSON.stringify(r.stdout.trim())}, want ${JSON.stringify(want)}`,
      );
      return want;
    },
  );

  await step("start", "taskville start --no-open prints a pairing link", ["install"], async () => {
    const port = await freePort();
    engine = spawn(join(bin, "taskville"), ["start", "--no-open", "--port", String(port)], {
      cwd: dirs.work,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    engine.stdout?.on("data", (c: Buffer) => {
      engineOut += c.toString("utf8");
    });
    engine.stderr?.on("data", (c: Buffer) => {
      engineErr += c.toString("utf8");
    });
    let exited: number | null | undefined;
    engine.once("exit", (code) => {
      exited = code;
    });
    try {
      pairLink = await until("the pairing link", 60_000, () => {
        if (exited !== undefined) throw new Error(`engine exited ${exited}`);
        return /http:\/\/127\.0\.0\.1:\d+\/#pair=[A-Za-z0-9_-]+/.exec(engineOut)?.[0];
      });
    } catch (error) {
      throw new Error(
        `${(error as Error).message}\nstdout:\n${tail(engineOut)}\nstderr:\n${tail(engineErr)}`,
      );
    }
    base = new URL(pairLink).origin;
    expect(base === `http://127.0.0.1:${port}`, `link ${pairLink} is not on port ${port}`);
    return base;
  });

  await step(
    "pair",
    "the link pairs in headless Chromium and the badge shows the release id",
    ["start"],
    async () => {
      const chromium = await launchChromium();
      browser = await chromium.launch({
        headless: true,
        args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
      });
      const context = await browser.newContext({ baseURL: base });
      page = await context.newPage();
      page.on("pageerror", (e: Error) => pageErrors.push(e.message));
      await page.goto(pairLink);
      // The same signals tests/e2e/web/smoke.spec.ts uses: the scene mounts and the overlay says paired.
      await page.getByTestId("scene-root").waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="overlay-root"]')?.textContent?.includes("paired"),
        null,
        { timeout: 30_000 },
      );
      const badge = page.locator("span[data-environment]").first();
      await badge.waitFor({ state: "visible", timeout: 30_000 });
      const text = ((await badge.textContent()) ?? "").replace(/\s+/g, " ").trim();
      expect(
        text === `${manifest.environment} · ${shortId}`,
        `release badge reads ${JSON.stringify(text)}, want ${JSON.stringify(`${manifest.environment} · ${shortId}`)}`,
      );
      expect(pageErrors.length === 0, `page errors: ${pageErrors.join(" | ")}`);
      return text;
    },
  );

  await step("init", "taskville init --yes in a throwaway git repo", ["start"], async () => {
    const git = await run("git", ["init", "-q", dirs.repo], { cwd: dirs.work, env });
    expect(git.code === 0, `git init failed: ${git.stderr}`);
    const r = await taskville(["init", "--yes"], { cwd: dirs.repo });
    expect(r.code === 0, `init exited ${r.code}\n${tail(r.stdout + r.stderr)}`);
    const settings = join(dirs.repo, ".claude/settings.local.json");
    expect(existsSync(settings), `init wrote no ${settings}\n${tail(r.stdout)}`);
    const projects = await api<{ projects: { id: string; roots: string[] }[] }>("/v1/projects");
    const mine = projects.projects.find((p) => p.roots.includes(dirs.repo));
    expect(
      mine !== undefined,
      `no project has root ${dirs.repo}: ${JSON.stringify(projects.projects)}`,
    );
    projectId = (mine as { id: string }).id;
    return `project ${projectId}`;
  });

  await step("doctor", "taskville doctor exits 0 with every check ok", ["init"], async () => {
    const r = await taskville(["doctor", "--json"], { cwd: dirs.repo });
    let checks: { id: string; status: string; message: string }[] = [];
    try {
      checks = JSON.parse(r.stdout);
    } catch {
      throw new Error(`doctor printed no JSON (exit ${r.code})\n${tail(r.stdout + r.stderr)}`);
    }
    const summary = checks.map((c) => `${c.status} ${c.id}: ${c.message}`).join("\n");
    const ids = checks.map((c) => c.id).join(",");
    expect(
      ids === "node,web,engine,hooks,shim,curl,project",
      `unexpected checks ${ids}\n${summary}`,
    );
    expect(
      checks.every((c) => c.status === "ok") && r.code === 0,
      `doctor exited ${r.code}\n${summary}`,
    );
    return summary;
  });

  await step(
    "hook",
    "a recorded hook posted through the installed shim reaches the engine",
    ["init"],
    async () => {
      const settings = JSON.parse(
        readFileSync(join(dirs.repo, ".claude/settings.local.json"), "utf8"),
      ) as {
        hooks?: Record<string, { hooks?: { type?: string; command?: string }[] }[]>;
      };
      const records = readFileSync(HOOK_FIXTURE, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as { input: Record<string, unknown> });
      const first = records[0]?.input;
      expect(first !== undefined, "the hook fixture is empty");
      const event = String(first?.hook_event_name);
      const command = settings.hooks?.[event]
        ?.flatMap((g) => g.hooks ?? [])
        .find((h) => h.type === "command")?.command;
      expect(
        command !== undefined,
        `init installed no ${event} hook in ${dirs.repo}/.claude/settings.local.json`,
      );
      // The way Claude Code runs it: `sh -c <command>` with the hook JSON on stdin, in the project,
      // with an environment that does not carry TASKVILLE_HOME (the command must name it itself).
      const hookEnv = { ...env };
      hookEnv.TASKVILLE_HOME = undefined;
      delete hookEnv.TASKVILLE_HOME;
      const payload = {
        ...first,
        cwd: dirs.repo,
        transcript_path: join(dirs.repo, "transcript.jsonl"),
      };
      const r = await run("sh", ["-c", command as string], {
        cwd: dirs.repo,
        env: hookEnv,
        input: JSON.stringify(payload),
        timeoutMs: 30_000,
      });
      expect(r.code === 0, `shim exited ${r.code}: ${r.stderr}`);
      const spool = join(dirs.taskvilleHome, "spool");
      const spooled = existsSync(spool)
        ? readdirSync(spool).filter((n) => /^claude-code.*\.jsonl$/.test(n))
        : [];
      const agent = await until("an agent from the hook in the snapshot", 15_000, async () => {
        const state = (await snapshotOf(projectId)).state;
        return Object.values(state.agents)[0];
      }).catch((error: Error) => {
        throw new Error(
          `${error.message}; spooled files: ${spooled.join(", ") || "none"}; command: ${command}`,
        );
      });
      expect(
        spooled.length === 0,
        `the shim spooled the event instead of posting it: ${spooled.join(", ")}`,
      );
      return `${event} -> agent ${agent.id} (${agent.kind})`;
    },
  );

  await step("demo", "taskville demo start produces the six demo agents", ["start"], async () => {
    const r = await taskville(
      ["demo", "start", "--seed", "7", "--speed", "300", "--duration", "30m"],
      {
        timeoutMs: 120_000,
      },
    );
    expect(r.code === 0, `demo exited ${r.code}\n${tail(r.stdout + r.stderr)}`);
    const state = (await snapshotOf("unsorted")).state;
    const names = Object.values(state.agents).map((a) => a.displayName ?? "");
    const missing = DEMO_AGENTS.filter((n) => !names.includes(n));
    expect(
      missing.length === 0,
      `the engine has agents [${names.join(", ")}], missing ${missing.join(", ")}`,
    );
    if (page !== undefined) {
      // The paired page shows them too (the smoke suite's check, one world label per agent).
      await until("six agent labels in the city", 30_000, async () => {
        const labels: string[] = await page
          .getByTestId("agent-label")
          .evaluateAll((els: HTMLElement[]) => els.map((el) => el.textContent ?? ""));
        return DEMO_AGENTS.every((n) => labels.some((t) => t.includes(n))) ? labels : undefined;
      });
    }
    return `agents ${names.join(", ")}`;
  });
}

let tarballSha256: string | undefined;
let pairLink = "";
const startedAt = new Date().toISOString();

try {
  await main();
} catch (error) {
  console.error(`harness error: ${error instanceof Error ? error.stack : error}`);
  results.push({
    id: "harness",
    title: "the harness itself",
    status: "fail",
    durationMs: 0,
    error: String(error),
  });
} finally {
  const passed = results.length > 0 && results.every((s) => s.status === "pass");
  const receipt = {
    format: 1,
    releaseId: manifest.id,
    version: manifest.version,
    environment: manifest.environment,
    tarballSha256: tarballSha256 ?? null,
    manifestTarballSha256: manifest.tarball.sha256,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    startedAt,
    passed,
    steps: results,
  };
  mkdirSync(dirname(args.receipt), { recursive: true });
  writeFileSync(args.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  await browser?.close().catch(() => {});
  if (engine !== undefined && engine.exitCode === null && engine.signalCode === null) {
    const gone = new Promise((r) => engine?.once("exit", r));
    engine.kill("SIGTERM");
    await Promise.race([gone, sleep(10_000)]);
    if (engine.exitCode === null && engine.signalCode === null) engine.kill("SIGKILL");
  }
  if (args.keepTemp) console.log(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
  console.log(`${passed ? "PASSED" : "FAILED"}: receipt ${args.receipt}`);
  process.exitCode = passed ? 0 : 1;
}
