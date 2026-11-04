import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Home, makeHome, SHELLS, TOKEN } from "./harness.ts";

// M5.12 round 2 (security review H1): the OpenTelemetry headers helper
// (apps/cli/hooks/claude-code-otel-headers.sh) prints the CLI token for whatever endpoint Claude
// Code resolves, and a shared repository settings file can set an endpoint variable to an
// attacker. Contract: the helper prints nothing and exits 0 unless every inherited
// OTEL_EXPORTER_OTLP_*ENDPOINT variable (generic, METRICS, LOGS, TRACES) is unset or starts with
// the engine's loopback origin `http://127.0.0.1:<port>`, where <port> comes from TASKVILLE_URL
// (default http://127.0.0.1:4807), the same loopback rule as the shim. The match is on scheme,
// host and port only: the value must equal the origin or continue with `/`, so
// `http://127.0.0.1:4807.evil.example` and `http://127.0.0.1:4807@evil.example` do not match.

const HELPER = join(import.meta.dirname, "..", "..", "hooks", "claude-code-otel-headers.sh");
const exec = promisify(execFile);
const URLS = "http://127.0.0.1:4807";

async function run(shell: string, home: Home, extra: Record<string, string>) {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", TASKVILLE_HOME: home.home, ...extra };
  try {
    const { stdout } = await exec(shell, [HELPER], { env });
    return { code: 0, stdout };
  } catch (error) {
    const e = error as { code?: number; stdout?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "" };
  }
}

const HEADER = `{"Authorization":"Bearer ${TOKEN}"}\n`;
const VARS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
] as const;
const FOREIGN = [
  "http://evil.example/v1/otlp",
  "https://127.0.0.1:4807/v1/otlp",
  "http://127.0.0.1:4808/v1/otlp",
  "http://localhost:4807/v1/otlp",
  "http://127.0.0.1:4807.evil.example/v1/otlp",
  "http://127.0.0.1:4807@evil.example/v1/otlp",
  "http://127.0.0.1/v1/otlp",
  "http://127.0.0.1:48070/v1/otlp",
];

describe.each(SHELLS)("claude-code-otel-headers.sh under %s", (shell) => {
  let home: Home;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => home.remove());

  it("prints the header when every endpoint variable is unset or the pinned loopback URL", async () => {
    const none = await run(shell, home, { TASKVILLE_URL: URLS });
    expect(none).toEqual({ code: 0, stdout: HEADER });
    const pinned = await run(shell, home, {
      TASKVILLE_URL: URLS,
      OTEL_EXPORTER_OTLP_ENDPOINT: `${URLS}/v1/otlp`,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${URLS}/v1/otlp/v1/metrics`,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${URLS}/v1/otlp/v1/logs`,
    });
    expect(pinned).toEqual({ code: 0, stdout: HEADER });
  });

  it("follows TASKVILLE_URL for the port, defaulting to 4807", async () => {
    const other = await run(shell, home, {
      TASKVILLE_URL: "http://127.0.0.1:5123",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:5123/v1/otlp",
    });
    expect(other).toEqual({ code: 0, stdout: HEADER });
    const mismatch = await run(shell, home, {
      TASKVILLE_URL: "http://127.0.0.1:5123",
      OTEL_EXPORTER_OTLP_ENDPOINT: `${URLS}/v1/otlp`,
    });
    expect(mismatch).toEqual({ code: 0, stdout: "" });
    const dflt = await run(shell, home, { OTEL_EXPORTER_OTLP_ENDPOINT: `${URLS}/v1/otlp` });
    expect(dflt).toEqual({ code: 0, stdout: HEADER });
  });

  it.each(VARS)("prints nothing and exits 0 when %s points anywhere else", async (name) => {
    for (const foreign of FOREIGN) {
      const result = await run(shell, home, { TASKVILLE_URL: URLS, [name]: foreign });
      expect(result, `${name}=${foreign}`).toEqual({ code: 0, stdout: "" });
    }
  });

  it("prints nothing when one variable is foreign even if the others are pinned", async () => {
    const result = await run(shell, home, {
      TASKVILLE_URL: URLS,
      OTEL_EXPORTER_OTLP_ENDPOINT: `${URLS}/v1/otlp`,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://attacker.example/v1/metrics",
    });
    expect(result).toEqual({ code: 0, stdout: "" });
  });

  it("prints nothing for a collector the user configured themselves (roborev 6864: Claude Code may ignore the project-scoped endpoint but still run this helper)", async () => {
    // The user's own config (or their shell) exports an external collector; the helper sees it in
    // its inherited environment and must not hand it the Taskville token.
    for (const name of VARS) {
      const result = await run(shell, home, {
        TASKVILLE_URL: URLS,
        [name]: "https://otel-collector.corp.example:4318",
      });
      expect(result, name).toEqual({ code: 0, stdout: "" });
      expect(result.stdout).not.toContain(TOKEN);
    }
  });
});
