import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guardRealSettings, json, read, type Sandbox, sandbox, tv } from "./helpers.ts";

// M5.12 (#104): `taskville install claude-code --otel` also writes the environment settings that
// make Claude Code export OpenTelemetry to the engine's OTLP receiver
// (POST /v1/otlp/v1/metrics and /v1/otlp/v1/logs). It is an addition to the normal install (the
// hooks are still written) with the same diff and confirmation rules as M2.08: the diff shows the
// new settings before anything is written, nothing is written without --yes or a "yes", and
// --dry-run writes nothing. Every test runs against a temp HOME and a temp project directory.
//
// Pinned settings (`settings.env`, strings, merged into any existing `env` object):
//   CLAUDE_CODE_ENABLE_TELEMETRY       "1"
//   OTEL_METRICS_EXPORTER              "otlp"
//   OTEL_LOGS_EXPORTER                 "otlp"
//   OTEL_EXPORTER_OTLP_PROTOCOL        "http/json"     (the receiver reads JSON only)
//   OTEL_EXPORTER_OTLP_ENDPOINT        "http://127.0.0.1:<port>/v1/otlp"
//                                      (the exporter appends /v1/metrics and /v1/logs; <port> and
//                                      the 127.0.0.1 rule follow the hook URL: --url, then
//                                      $TASKVILLE_URL, then config.json's port)
// The receiver needs the CLI token, which must never be written to settings or printed. The
// credential reaches Claude Code through its `otelHeadersHelper` setting, a top-level string
// naming a command that prints the headers as JSON; the installer points it at a script in the
// Taskville home that reads <home>/token itself, like the shim does. No
// `OTEL_EXPORTER_OTLP_HEADERS` is written.

guardRealSettings();

let sb: Sandbox;
afterEach(() => sb?.remove());

const PROJECT = ["--scope", "project"];
const ENV = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4807/v1/otlp",
  // Round 2 (security review H1): the signal-specific endpoints are pinned too, so a shared
  // settings file cannot redirect one signal; traces are switched off.
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:4807/v1/otlp/v1/metrics",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4807/v1/otlp/v1/logs",
  OTEL_TRACES_EXPORTER: "none",
};
const TOKEN = "cli-secret-Zq7Xw2Lr9Kd4Mn8Pv3Ts6Hb1Jc5Gf0Ye2U";

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function withToken(box: Sandbox) {
  mkdirSync(box.tv, { recursive: true, mode: 0o700 });
  writeFileSync(join(box.tv, "token"), `${TOKEN}\n`, { mode: 0o600 });
}
const env = (path: string) => json(path).env as Record<string, string>;

describe("install claude-code --otel", () => {
  it("shows the env settings in the diff and writes nothing without a confirmation", async () => {
    sb = sandbox();
    const r = await tv(sb, ["install", "claude-code", ...PROJECT, "--otel"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(sb.projectSettings);
    for (const [key, value] of Object.entries(ENV)) {
      expect(r.stdout, key).toContain(`+    "${key}": "${value}"`);
    }
    expect(r.stdout).toContain(`+  "otelHeadersHelper"`);
    expect(r.stderr).toMatch(/--yes/);
    expect(existsSync(sb.projectSettings)).toBe(false);
  });

  it("asks once, after printing the diff, and writes only when the answer is yes", async () => {
    sb = sandbox();
    const asked: { question: string; printed: string }[] = [];
    let out = "";
    const io = (answer: boolean) => ({
      stdout: (s: string) => {
        out += s;
      },
      confirm: async (question: string) => {
        asked.push({ question, printed: out });
        return answer;
      },
    });
    const no = await tv(sb, ["install", "claude-code", ...PROJECT, "--otel"], io(false));
    expect(no.code).toBe(1);
    expect(existsSync(sb.projectSettings)).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.printed).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");

    const yes = await tv(sb, ["install", "claude-code", ...PROJECT, "--otel"], io(true));
    expect(yes.code, yes.stderr).toBe(0);
    expect(env(sb.projectSettings)).toMatchObject(ENV);
    expect(typeof json(sb.projectSettings).otelHeadersHelper).toBe("string");
  });

  it("--dry-run prints the diff and writes nothing", async () => {
    sb = sandbox();
    const r = await tv(sb, ["install", "claude-code", ...PROJECT, "--otel", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(existsSync(sb.projectSettings)).toBe(false);
    expect(existsSync(sb.userSettings)).toBe(false);
  });

  it("writes the project settings file only, never the user settings", async () => {
    sb = sandbox();
    const r = await tv(sb, ["install", "claude-code", ...PROJECT, "--otel", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(env(sb.projectSettings)).toMatchObject(ENV);
    expect(existsSync(sb.userSettings)).toBe(false);
  });

  it("still installs the hooks, and keeps the settings that were already there", async () => {
    sb = sandbox();
    write(
      sb.projectSettings,
      `${JSON.stringify({ model: "opus", env: { MY_VAR: "keep-me" }, permissions: { allow: ["Bash(ls:*)"] } }, null, 2)}\n`,
    );
    const r = await tv(sb, ["install", "claude-code", ...PROJECT, "--otel", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    const settings = json(sb.projectSettings);
    expect(settings.model).toBe("opus");
    expect(settings.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(env(sb.projectSettings)).toEqual({ MY_VAR: "keep-me", ...ENV });
    expect(Object.keys(settings.hooks as object)).toContain("PreToolUse");
  });

  it("follows --url for the port and writes 127.0.0.1 even when given localhost", async () => {
    sb = sandbox();
    const r = await tv(sb, [
      "install",
      "claude-code",
      ...PROJECT,
      "--otel",
      "--yes",
      "--url",
      "http://localhost:5123",
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(env(sb.projectSettings).OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
      "http://127.0.0.1:5123/v1/otlp",
    );
  });

  it("never writes or prints the CLI token, and sends no OTEL_EXPORTER_OTLP_HEADERS", async () => {
    sb = sandbox();
    withToken(sb);
    const dry = await tv(sb, ["install", "claude-code", ...PROJECT, "--otel", "--dry-run"]);
    const real = await tv(sb, ["install", "claude-code", ...PROJECT, "--otel", "--yes"]);
    expect(real.code, real.stderr).toBe(0);
    for (const text of [
      dry.stdout,
      dry.stderr,
      real.stdout,
      real.stderr,
      read(sb.projectSettings),
    ]) {
      expect(text).not.toContain(TOKEN);
    }
    expect(Object.keys(env(sb.projectSettings))).not.toContain("OTEL_EXPORTER_OTLP_HEADERS");
    // The permission-bridge hook (M4.04) writes an Authorization header that holds the variable
    // name, never a token; the OTel credential comes only from the helper command, which reads
    // the token at run time.
    const helper = json(sb.projectSettings).otelHeadersHelper;
    expect(typeof helper).toBe("string");
    expect(helper).not.toMatch(/Bearer/i);
  });

  it("is a no-op the second time: already installed, file unchanged", async () => {
    sb = sandbox();
    await tv(sb, ["install", "claude-code", ...PROJECT, "--otel", "--yes"]);
    const before = read(sb.projectSettings);
    const again = await tv(sb, ["install", "claude-code", ...PROJECT, "--otel", "--yes"]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/already installed/i);
    expect(read(sb.projectSettings)).toBe(before);
  });

  it("writes no telemetry settings without --otel (the plain install is unchanged)", async () => {
    sb = sandbox();
    const r = await tv(sb, ["install", "claude-code", ...PROJECT, "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    const settings = json(sb.projectSettings);
    expect(settings.env).toBeUndefined();
    expect(settings.otelHeadersHelper).toBeUndefined();
    expect(read(sb.projectSettings)).not.toContain("OTEL_");
  });
});

// Round 2 (security review H1, H2 and roborev 6864 c).
describe("install claude-code --otel: pinned endpoints", () => {
  it("overwrites a conflicting endpoint a shared settings file already set, and shows it in the diff", async () => {
    sb = sandbox();
    write(
      sb.projectSettings,
      `${JSON.stringify({ env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://attacker.example/m", OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://attacker.example/l" } }, null, 2)}\n`,
    );
    const dry = await tv(sb, ["install", "claude-code", ...PROJECT, "--otel", "--dry-run"]);
    expect(dry.stdout).toContain("attacker.example");
    const r = await tv(sb, ["install", "claude-code", ...PROJECT, "--otel", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(env(sb.projectSettings)).toMatchObject(ENV);
    expect(read(sb.projectSettings)).not.toContain("attacker.example");
  });

  it("pins the signal endpoints to the --url port and gives the helper the same TASKVILLE_URL", async () => {
    sb = sandbox();
    const r = await tv(sb, [
      "install",
      "claude-code",
      ...PROJECT,
      "--otel",
      "--yes",
      "--url",
      "http://localhost:5123",
    ]);
    expect(r.code, r.stderr).toBe(0);
    const e = env(sb.projectSettings);
    expect(e.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe("http://127.0.0.1:5123/v1/otlp/v1/metrics");
    expect(e.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe("http://127.0.0.1:5123/v1/otlp/v1/logs");
    expect(e.OTEL_TRACES_EXPORTER).toBe("none");
    expect(json(sb.projectSettings).otelHeadersHelper).toContain("http://127.0.0.1:5123");
  });
});

describe("install claude-code --otel: scope", () => {
  it.each([
    ["--scope", "user"],
    ["--scope", "other"],
  ])("fails with a usage error before any write for %s %s", async (flag, scope) => {
    sb = sandbox();
    for (const extra of [["--yes"], ["--dry-run"], []]) {
      const r = await tv(sb, ["install", "claude-code", flag, scope, "--otel", ...extra]);
      expect(r.code, extra.join(" ")).not.toBe(0);
      expect(r.stderr).toMatch(/--otel/);
      expect(r.stderr).toMatch(/project/);
    }
    // Nothing under the temp HOME: no settings, no Taskville home, no helper copy.
    expect(readdirSync(sb.home)).toEqual([]);
    expect(existsSync(sb.userSettings)).toBe(false);
  });

  it("fails without --scope too (no default scope is assumed for --otel)", async () => {
    sb = sandbox();
    const r = await tv(sb, ["install", "claude-code", "--otel", "--yes"]);
    expect(r.code).not.toBe(0);
    expect(readdirSync(sb.home)).toEqual([]);
  });
});

describe("uninstall claude-code after install --otel", () => {
  const uninstall = () => tv(sb, ["uninstall", "claude-code", ...PROJECT, "--yes"]);

  it("restores the file exactly when nothing else changed", async () => {
    sb = sandbox();
    const original = `${JSON.stringify({ model: "opus", env: { MY_VAR: "keep-me" } }, null, 2)}\n`;
    write(sb.projectSettings, original);
    await tv(sb, ["install", "claude-code", ...PROJECT, "--otel", "--yes"]);
    expect(env(sb.projectSettings)).toMatchObject(ENV);
    const r = await uninstall();
    expect(r.code, r.stderr).toBe(0);
    expect(read(sb.projectSettings)).toBe(original);
  });

  it("removes exactly the env keys and otelHeadersHelper that install wrote, keeping later edits", async () => {
    sb = sandbox();
    write(sb.projectSettings, `${JSON.stringify({ env: { MY_VAR: "keep-me" } }, null, 2)}\n`);
    await tv(sb, ["install", "claude-code", ...PROJECT, "--otel", "--yes"]);
    // Edit after install: a new setting, a new env var, and the user's own collector replacing
    // one pinned value (which is then no longer what install wrote, so it stays).
    const edited = json(sb.projectSettings);
    edited.model = "sonnet";
    edited.env = {
      ...(edited.env as object),
      LATER: "1",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://collector.corp.example/logs",
    };
    write(sb.projectSettings, `${JSON.stringify(edited, null, 2)}\n`);
    const r = await uninstall();
    expect(r.code, r.stderr).toBe(0);
    const after = json(sb.projectSettings);
    expect(after.model).toBe("sonnet");
    expect(after.otelHeadersHelper).toBeUndefined();
    expect(after.env).toEqual({
      MY_VAR: "keep-me",
      LATER: "1",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://collector.corp.example/logs",
    });
    expect(read(sb.projectSettings)).not.toContain("CLAUDE_CODE_ENABLE_TELEMETRY");
  });

  it("drops an env object that becomes empty and leaves a look-alike helper alone", async () => {
    sb = sandbox();
    await tv(sb, ["install", "claude-code", ...PROJECT, "--otel", "--yes"]);
    const edited = json(sb.projectSettings);
    edited.model = "sonnet"; // forces the structural path, not the byte-for-byte restore
    write(sb.projectSettings, `${JSON.stringify(edited, null, 2)}\n`);
    const r = await uninstall();
    expect(r.code, r.stderr).toBe(0);
    const after = json(sb.projectSettings);
    expect(after.env).toBeUndefined();
    expect(after.otelHeadersHelper).toBeUndefined();
    expect(after.model).toBe("sonnet");

    const own = { otelHeadersHelper: "/usr/local/bin/my-headers", env: { MY_VAR: "1" } };
    write(sb.projectSettings, `${JSON.stringify(own, null, 2)}\n`);
    const again = await uninstall();
    expect(again.code, again.stderr).toBe(0);
    expect(json(sb.projectSettings)).toEqual(own);
  });
});
