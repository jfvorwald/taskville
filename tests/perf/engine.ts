// Spawns the real engine (`taskville serve --headless`) in a throwaway home for the perf checks,
// and talks to it over HTTP with the CLI token, as the CLI and demo producer do.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EventBatchResponse } from "../../packages/protocol/src/index.ts";

const CLI_MAIN = resolve(import.meta.dirname, "../../apps/cli/src/main.ts");

export interface RunningEngine {
  base: string;
  pid: number;
  token: string;
  home: string;
  /** Resident set size of the engine process, in KiB (`ps -o rss=`). */
  rssKib(): number;
  post(path: string, body: unknown): Promise<Response>;
  ingest(events: unknown[]): Promise<EventBatchResponse>;
  get(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      srv.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function waitForListening(child: ChildProcess): Promise<string> {
  return new Promise((done, fail) => {
    let out = "";
    const timer = setTimeout(() => fail(new Error(`engine did not start:\n${out}`)), 20_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (match?.[1]) {
        clearTimeout(timer);
        done(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`engine exited with ${code}:\n${out}`));
    });
  });
}

/** Starts `node apps/cli/src/main.ts serve --headless` on a free port in a new home. */
export async function startEngine(): Promise<RunningEngine> {
  const home = mkdtempSync(join(tmpdir(), "taskville-perf-"));
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [CLI_MAIN, "serve", "--headless", "--home", home, "--port", String(port)],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const base = await waitForListening(child);
  const pid = child.pid ?? 0;
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const headers = { Authorization: `Bearer ${token}` };
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    base,
    pid,
    token,
    home,
    rssKib: () =>
      Number(
        execFileSync("ps", ["-o", "rss=", "-p", String(pid)])
          .toString()
          .trim(),
      ),
    post,
    async ingest(events) {
      const res = await post("/v1/events/batch", { events });
      if (res.status !== 200) throw new Error(`ingest answered ${res.status}`);
      return (await res.json()) as EventBatchResponse;
    },
    get: (path, init = {}) =>
      fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } }),
    async stop() {
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      child.kill("SIGINT");
      await exited;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export async function createProject(engine: RunningEngine, id: string): Promise<void> {
  const res = await engine.post("/v1/projects", { id, name: id, roots: [] });
  if (res.status !== 201) throw new Error(`project add answered ${res.status}`);
}

/** Median RSS of a few samples a moment apart, in KiB, so one GC pause does not decide. */
export async function sampleRss(engine: RunningEngine, samples = 5): Promise<number> {
  const values: number[] = [];
  for (let i = 0; i < samples; i++) {
    values.push(engine.rssKib());
    await new Promise((r) => setTimeout(r, 100));
  }
  values.sort((a, b) => a - b);
  return values[samples >> 1] as number;
}

export interface Machine {
  node: string;
  platform: string;
  arch: string;
  cpu: string;
  cores: number;
  memoryGiB: number;
}

export async function machine(): Promise<Machine> {
  const os = await import("node:os");
  return {
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
  };
}
