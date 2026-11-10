import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
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

/** `count` distinct ports, all held open together so none repeats. */
export async function freePorts(count: number): Promise<number[]> {
  const servers: Server[] = [];
  try {
    return await Promise.all(
      Array.from(
        { length: count },
        () =>
          new Promise<number>((resolve, reject) => {
            const server = createServer();
            servers.push(server);
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              resolve(typeof address === "object" && address !== null ? address.port : 0);
            });
          }),
      ),
    );
  } finally {
    await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
  }
}

let sandboxHome: string | undefined;
/** An empty home shared by every test that names none, so no test reads the real ~/.taskville. */
export function sandboxTaskvilleHome(): string {
  if (sandboxHome === undefined) {
    sandboxHome = mkdtempSync(join(tmpdir(), "taskville-cli-sandbox-"));
    process.once("exit", () => rmSync(sandboxHome as string, { recursive: true, force: true }));
  }
  return sandboxHome;
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
    cwd: io.cwd ?? process.cwd(),
    ...io,
    // Without --home or TASKVILLE_HOME the CLI would read the developer's real ~/.taskville.
    // A test that sets HOME (the install tests) or TASKVILLE_HOME already names its own home.
    env:
      argv.includes("--home") || io.env?.HOME !== undefined || io.env?.TASKVILLE_HOME !== undefined
        ? (io.env ?? {})
        : { TASKVILLE_HOME: sandboxTaskvilleHome(), ...io.env },
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
