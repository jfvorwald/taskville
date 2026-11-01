import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "../../../apps/cli/src/main.ts";

/** Where apps/web/e2e/engine.ts writes the one-time pairing codes and its throwaway home. */
export const CODES_FILE = fileURLToPath(
  new URL("../../../apps/web/test-results/pairing-codes.json", import.meta.url),
);

export const PORT = Number(process.env.E2E_PORT ?? 4886);

/** The six agents the seeded demo (seed 7) always creates. */
export const CORE = ["Ada", "Brook", "Cyd", "Dee", "Eli", "Fay"];

/**
 * The pairing code named `web` and the engine's home. apps/web/e2e/engine.ts must issue a code
 * with that name (add "web" to its CODE_NAMES), because every code is single use and the engine
 * keeps at most five.
 */
export function webCodes(): { web: string; home: string } {
  const codes = JSON.parse(readFileSync(CODES_FILE, "utf8")) as { web?: string; home: string };
  if (!codes.web) throw new Error("apps/web/e2e/engine.ts must issue a pairing code named `web`");
  return { web: codes.web, home: codes.home };
}

export interface DemoOptions {
  /** Simulated length, for example "30m". At speed 120 that is 15 s of real time. */
  duration?: string;
  speed?: number;
  seed?: number;
  port?: number;
  signal?: AbortSignal;
}

/** Runs the seeded demo producer in process against the e2e engine. Resolves with its exit code. */
export async function runDemo(
  home: string,
  { duration = "30m", speed = 120, seed = 7, port = PORT, signal }: DemoOptions = {},
): Promise<{ code: number; output: string }> {
  const out: string[] = [];
  const write = (t: string) => out.push(t);
  const code = await run(
    [
      "demo",
      "start",
      "--project",
      "unsorted",
      "--seed",
      String(seed),
      "--speed",
      String(speed),
      "--duration",
      duration,
      "--home",
      home,
      "--url",
      `http://127.0.0.1:${port}`,
    ],
    { stdout: write, stderr: write, env: {}, cwd: home, ...(signal ? { signal } : {}) },
  );
  return { code, output: out.join("") };
}
