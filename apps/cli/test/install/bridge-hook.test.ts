import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BRIDGE_ENV,
  bridgeHook,
  EVENTS,
  guardRealSettings,
  json,
  read,
  type Sandbox,
  sandbox,
  tv,
} from "./helpers.ts";

// M4.04 (#61): `taskville install claude-code` also adds the PermissionRequest `http` hook that
// points at the permission bridge (ARCHITECTURE.md 8.1; spike S-1 for the hook config shape). The
// bridge token travels through `allowedEnvVars`; it is never written into the settings file.
//
// Pinned entry (settings.hooks.PermissionRequest, one group, no matcher):
//   { "hooks": [ { "type": "http",
//                  "url": "http://127.0.0.1:<port>/v1/bridge/claude-code/permission",
//                  "timeout": <holdWindowSeconds + 5>,
//                  "headers": { "Authorization": "Bearer $TASKVILLE_BRIDGE_TOKEN" },
//                  "allowedEnvVars": ["TASKVILLE_BRIDGE_TOKEN"] } ] }
// <port> follows the telemetry hooks (--url, $TASKVILLE_URL, config.json port); the timeout is
// config.json's bridge.holdWindowSeconds (default 90) plus 5, read even when --url is given.

guardRealSettings();

let sb: Sandbox;
afterEach(() => sb?.remove());

type Hooks = Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]>;
const hooksOf = (path: string) => json(path).hooks as Hooks;
const install = (extra: string[] = [], scope = "user") =>
  tv(sb, ["install", "claude-code", "--scope", scope, "--yes", ...extra]);

function writeConfig(box: Sandbox, config: unknown) {
  mkdirSync(box.tv, { recursive: true });
  chmodSync(box.tv, 0o700);
  const path = join(box.tv, "config.json");
  writeFileSync(path, JSON.stringify(config));
  chmodSync(path, 0o600);
}

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

describe("install: the PermissionRequest http hook", () => {
  it("adds one http hook to the bridge route, with the token through allowedEnvVars and timeout 95", async () => {
    sb = sandbox();
    const r = await install();
    expect(r.code, r.stderr).toBe(0);
    expect(hooksOf(sb.userSettings).PermissionRequest).toEqual([{ hooks: [bridgeHook()] }]);
    expect(bridgeHook().timeout).toBe(95);
    expect(bridgeHook().allowedEnvVars).toEqual([BRIDGE_ENV]);
  });

  it("shows the hook in the diff before anything is written", async () => {
    sb = sandbox();
    const r = await tv(sb, ["install", "claude-code", "--scope", "user", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`+    "PermissionRequest": [`);
    expect(r.stdout).toContain(`"type": "http"`);
    expect(r.stdout).toContain(`"url": "http://127.0.0.1:4807/v1/bridge/claude-code/permission"`);
    expect(r.stdout).toContain(`"timeout": 95`);
    expect(r.stdout).toContain(`"allowedEnvVars"`);
    expect(existsSync(sb.userSettings)).toBe(false);
  });

  it("never writes the bridge token into the settings, the diff, or any output", async () => {
    sb = sandbox();
    const token = "bridge-secret-Zq7Xw2Lr9Kd4Mn8Pv3Ts6Hb1Jc5Gf0Ye2U";
    mkdirSync(sb.tv, { recursive: true, mode: 0o700 });
    writeFileSync(join(sb.tv, "bridge-token"), `${token}\n`, { mode: 0o600 });
    const dry = await tv(sb, ["install", "claude-code", "--scope", "user", "--dry-run"]);
    const real = await install();
    expect(real.code, real.stderr).toBe(0);
    for (const text of [dry.stdout, dry.stderr, real.stdout, real.stderr, read(sb.userSettings)]) {
      expect(text).not.toContain(token);
    }
    expect(String(JSON.stringify(hooksOf(sb.userSettings).PermissionRequest))).toContain(
      `$${BRIDGE_ENV}`,
    );
  });

  it("tells the user which variable to export and where the token lives", async () => {
    sb = sandbox();
    const r = await install();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(BRIDGE_ENV);
    expect(r.stdout).toContain(join(sb.tv, "bridge-token"));
  });

  it("follows the engine URL of the telemetry hooks", async () => {
    sb = sandbox();
    const r = await install(["--url", "http://127.0.0.1:5123"]);
    expect(r.code, r.stderr).toBe(0);
    expect(hooksOf(sb.userSettings).PermissionRequest).toEqual([
      { hooks: [bridgeHook("http://127.0.0.1:5123")] },
    ]);
  });

  it("sets timeout to the configured hold window plus 5 s, also when --url is given", async () => {
    sb = sandbox();
    writeConfig(sb, { bridge: { holdWindowSeconds: 120 } });
    expect((await install()).code).toBe(0);
    expect(hooksOf(sb.userSettings).PermissionRequest).toEqual([
      { hooks: [bridgeHook("http://127.0.0.1:4807", 125)] },
    ]);
    sb.remove();

    sb = sandbox();
    writeConfig(sb, { bridge: { holdWindowSeconds: 300 } });
    expect((await install(["--url", "http://127.0.0.1:4807"])).code).toBe(0);
    expect(hooksOf(sb.userSettings).PermissionRequest).toEqual([
      { hooks: [bridgeHook("http://127.0.0.1:4807", 305)] },
    ]);
  });

  it("refuses a hold window outside 1 to 300 and writes nothing", async () => {
    sb = sandbox();
    writeConfig(sb, { bridge: { holdWindowSeconds: 301 } });
    const r = await install();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("bridge.holdWindowSeconds");
    expect(existsSync(sb.userSettings)).toBe(false);
    expect(existsSync(sb.shim)).toBe(false);
  });

  it("is idempotent, and a changed hold window replaces the entry instead of adding one", async () => {
    sb = sandbox();
    expect((await install()).code).toBe(0);
    const first = read(sb.userSettings);
    const again = await install();
    expect(again.stdout).toMatch(/already installed/i);
    expect(read(sb.userSettings)).toBe(first);

    writeConfig(sb, { bridge: { holdWindowSeconds: 60 } });
    const changed = await install();
    expect(changed.code, changed.stderr).toBe(0);
    expect(changed.stdout).not.toMatch(/already installed/i);
    expect(hooksOf(sb.userSettings).PermissionRequest).toEqual([
      { hooks: [bridgeHook("http://127.0.0.1:4807", 65)] },
    ]);
  });

  it("reinstalls when the bridge entry was narrowed with a matcher or its timeout edited", async () => {
    sb = sandbox();
    await install();
    const edited = json(sb.userSettings);
    const group = (edited.hooks as Hooks).PermissionRequest?.[0];
    if (group === undefined) throw new Error("no PermissionRequest group");
    group.matcher = "Bash";
    group.hooks[0] = { ...group.hooks[0], timeout: 5 };
    writeFileSync(sb.userSettings, `${JSON.stringify(edited, null, 2)}\n`);
    const r = await install();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/already installed/i);
    expect(hooksOf(sb.userSettings).PermissionRequest).toEqual([{ hooks: [bridgeHook()] }]);
  });

  it("writes it for --scope project too", async () => {
    sb = sandbox();
    const r = await install([], "project");
    expect(r.code, r.stderr).toBe(0);
    expect(hooksOf(sb.projectSettings).PermissionRequest).toEqual([{ hooks: [bridgeHook()] }]);
  });

  it("keeps the user's own PermissionRequest hooks beside it", async () => {
    sb = sandbox();
    const mine = { type: "command", command: "/usr/local/bin/my-permission-hook" };
    const other = { type: "http", url: "http://127.0.0.1:9999/other" };
    write(
      sb.userSettings,
      `${JSON.stringify({ hooks: { PermissionRequest: [{ matcher: "Bash", hooks: [mine, other] }] } }, null, 2)}\n`,
    );
    expect((await install()).code).toBe(0);
    expect(hooksOf(sb.userSettings).PermissionRequest).toEqual([
      { matcher: "Bash", hooks: [mine, other] },
      { hooks: [bridgeHook()] },
    ]);
  });
});

describe("uninstall: only Taskville's PermissionRequest entry", () => {
  const mine = { type: "command", command: "/usr/local/bin/my-permission-hook" };
  const other = { type: "http", url: "http://127.0.0.1:9999/other" };
  // Same host and prefix as the bridge route, but not the route: not Taskville's.
  const lookAlike = {
    type: "http",
    url: "http://127.0.0.1:4807/v1/bridge/claude-code/permission/extra",
  };

  it("removes the bridge hook and leaves the user's PermissionRequest hooks, even after the file changed", async () => {
    sb = sandbox();
    write(
      sb.userSettings,
      `${JSON.stringify({ hooks: { PermissionRequest: [{ matcher: "Bash", hooks: [mine, other, lookAlike] }] } }, null, 2)}\n`,
    );
    await install();
    const edited = json(sb.userSettings);
    edited.model = "sonnet";
    writeFileSync(sb.userSettings, `${JSON.stringify(edited, null, 2)}\n`);
    const r = await tv(sb, ["uninstall", "claude-code", "--scope", "user", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(json(sb.userSettings)).toEqual({
      model: "sonnet",
      hooks: { PermissionRequest: [{ matcher: "Bash", hooks: [mine, other, lookAlike] }] },
    });
  });

  it("restores the original byte for byte when only Taskville's entries changed", async () => {
    sb = sandbox();
    const original = `${JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [mine] }] } }, null, 4)}`;
    write(sb.userSettings, original);
    await install();
    expect(read(sb.userSettings)).not.toBe(original);
    const r = await tv(sb, ["uninstall", "claude-code", "--scope", "user", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(read(sb.userSettings)).toBe(original);
  });

  it("leaves no PermissionRequest key, and removes the file install created", async () => {
    sb = sandbox();
    await install();
    expect((await tv(sb, ["uninstall", "claude-code", "--scope", "user", "--yes"])).code).toBe(0);
    expect(existsSync(sb.userSettings)).toBe(false);
  });

  it("counts a PermissionRequest-only install as installed", async () => {
    sb = sandbox();
    await install();
    // Drop the telemetry entries by hand, leaving only the bridge hook.
    const only = json(sb.userSettings);
    const hooks = only.hooks as Hooks;
    for (const event of EVENTS) delete hooks[event];
    writeFileSync(sb.userSettings, `${JSON.stringify(only, null, 2)}\n`);
    const r = await tv(sb, ["uninstall", "claude-code", "--scope", "user", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/not installed/i);
    expect(existsSync(sb.userSettings)).toBe(false);
  });

  it("shows the removal of the bridge hook in the diff", async () => {
    sb = sandbox();
    await install();
    const r = await tv(sb, ["uninstall", "claude-code", "--scope", "user", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`-    "PermissionRequest": [`);
    expect(r.stdout).toContain("/v1/bridge/claude-code/permission");
  });
});
