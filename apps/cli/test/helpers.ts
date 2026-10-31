import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Io, run } from "../src/main.ts";

export const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures", "events");
export const GOLDEN = join(import.meta.dirname, "golden");

export function tempDir(prefix = "taskville-cli-"): { path: string; remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

/** A port that was free a moment ago (the engine needs a fixed port for its Host check). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in process. */
export async function cli(argv: string[], io: Partial<Io> = {}): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    env: {},
    cwd: io.cwd ?? process.cwd(),
    ...io,
  });
  return { code, stdout, stderr };
}

/** Starts `taskville serve --headless` in process; resolves once it printed the pairing URL. */
export async function startServe(home: string, port: number, now: () => Date) {
  const controller = new AbortController();
  let out = "";
  let err = "";
  let ready: () => void = () => {};
  const listening = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const exited = run(["serve", "--headless", "--home", home, "--port", String(port)], {
    stdout: (s) => {
      out += s;
      if (out.includes("#pair=")) ready();
    },
    stderr: (s) => {
      err += s;
    },
    env: {},
    cwd: home,
    signal: controller.signal,
    now,
  });
  await Promise.race([
    listening,
    exited.then((code) => Promise.reject(new Error(`serve exited ${code}: ${err}`))),
  ]);
  return {
    url: `http://127.0.0.1:${port}`,
    output: () => out,
    errors: () => err,
    stop: async () => {
      controller.abort();
      return exited;
    },
  };
}
