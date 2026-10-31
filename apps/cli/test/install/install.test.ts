import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVENTS,
  guardRealSettings,
  isLink,
  json,
  mode,
  read,
  type Sandbox,
  sandbox,
  tv,
} from "./helpers.ts";

// `taskville install claude-code` and `taskville uninstall claude-code` (#29, ARCHITECTURE.md 8.1
// "Installing"), always against a temporary HOME and project.

guardRealSettings();

let sb: Sandbox;

/** The command install writes for this sandbox: home and URL always explicit. */
const commandFor = (box: Sandbox, url = "http://127.0.0.1:4807") =>
  `TASKVILLE_HOME='${box.tv}' TASKVILLE_URL='${url}' '${box.shim}'`;
afterEach(() => sb?.remove());

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
type Hooks = Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]>;
const hooksOf = (path: string) => json(path).hooks as Hooks;
const ours = (path: string) =>
  Object.values(hooksOf(path))
    .flat()
    .flatMap((group) => group.hooks)
    .filter((h) => String(h.command).includes("taskville-claude-code-shim.sh"));

describe("install --scope user", () => {
  it("adds one async command hook per telemetry event, pointing at a copied shim", async () => {
    sb = sandbox();
    const r = await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    const hooks = hooksOf(sb.userSettings);
    expect(Object.keys(hooks).sort()).toEqual([...EVENTS].sort());
    expect(hooks).not.toHaveProperty("PermissionRequest");
    for (const event of EVENTS) {
      expect(hooks[event]).toEqual([
        { hooks: [{ type: "command", command: commandFor(sb), async: true }] },
      ]);
    }
    // The shim is a private copy in the Taskville home, so the path survives package moves.
    expect(read(sb.shim)).toBe(read(join(import.meta.dirname, "../../hooks/claude-code-shim.sh")));
    expect(mode(sb.shim)).toBe(0o755);
    expect(mode(dirname(sb.shim))).toBe(0o700);
  });

  it("prints the exact diff, and writes nothing without --yes or a confirmation", async () => {
    sb = sandbox();
    const r = await tv(sb, ["install", "claude-code", "--scope", "user"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(sb.userSettings);
    expect(r.stdout).toContain(`+    "SessionStart": [`);
    expect(r.stderr).toMatch(/--yes/);
    expect(existsSync(sb.userSettings)).toBe(false);
    expect(existsSync(sb.shim)).toBe(false);
  });

  it("asks before writing and respects the answer", async () => {
    sb = sandbox();
    const questions: string[] = [];
    const no = await tv(sb, ["install", "claude-code", "--scope", "user"], {
      confirm: async (q) => {
        questions.push(q);
        return false;
      },
    });
    expect(no.code).toBe(1);
    expect(questions).toHaveLength(1);
    expect(existsSync(sb.userSettings)).toBe(false);
    const yes = await tv(sb, ["install", "claude-code", "--scope", "user"], {
      confirm: async () => true,
    });
    expect(yes.code, yes.stderr).toBe(0);
    expect(ours(sb.userSettings)).toHaveLength(EVENTS.length);
  });

  it("--dry-run prints the diff and writes nothing", async () => {
    sb = sandbox();
    const r = await tv(sb, ["install", "claude-code", "--scope", "user", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`"async": true`);
    expect(existsSync(sb.userSettings)).toBe(false);
  });

  it("keeps every unknown key and other tools' hooks", async () => {
    sb = sandbox();
    const other = { type: "command", command: "/usr/local/bin/other-tool --hook" };
    write(
      sb.userSettings,
      `${JSON.stringify(
        {
          model: "opus",
          permissions: { allow: ["Bash(ls:*)"] },
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [other] }],
            ConfigChange: [{ hooks: [other] }],
          },
          custom: { nested: [1, 2, { x: null }] },
        },
        null,
        2,
      )}\n`,
    );
    expect((await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"])).code).toBe(0);
    const after = json(sb.userSettings);
    expect(after.model).toBe("opus");
    expect(after.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(after.custom).toEqual({ nested: [1, 2, { x: null }] });
    const hooks = after.hooks as Hooks;
    expect(hooks.ConfigChange).toEqual([{ hooks: [other] }]);
    expect(hooks.PreToolUse?.[0]).toEqual({ matcher: "Bash", hooks: [other] });
    expect(hooks.PreToolUse).toHaveLength(2);
  });

  it("is idempotent: a reinstall changes nothing and adds no duplicates", async () => {
    sb = sandbox();
    expect((await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"])).code).toBe(0);
    const first = read(sb.userSettings);
    const again = await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/already installed/i);
    expect(read(sb.userSettings)).toBe(first);
    expect(ours(sb.userSettings)).toHaveLength(EVENTS.length);
  });

  it("replaces its own entries when the hook command changes (another port)", async () => {
    sb = sandbox();
    await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"]);
    const r = await tv(sb, [
      "install",
      "claude-code",
      "--scope",
      "user",
      "--yes",
      "--url",
      "http://127.0.0.1:5123",
    ]);
    expect(r.code, r.stderr).toBe(0);
    const commands = ours(sb.userSettings).map((h) => h.command);
    expect(commands).toHaveLength(EVENTS.length);
    expect(new Set(commands)).toEqual(new Set([commandFor(sb, "http://127.0.0.1:5123")]));
  });

  it("keeps the file's mode and writes atomically (no temp files left)", async () => {
    sb = sandbox();
    write(sb.userSettings, `{"model": "opus"}\n`);
    chmodSync(sb.userSettings, 0o640);
    expect((await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"])).code).toBe(0);
    expect(mode(sb.userSettings)).toBe(0o640);
    const leftovers = execFileSync("ls", ["-a", dirname(sb.userSettings)], { encoding: "utf8" })
      .split("\n")
      .filter((f) => f.startsWith(".settings.json") || f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("refuses a malformed or unexpected settings file and leaves it untouched", async () => {
    for (const text of ["{ not json", "[]", `{"hooks": []}`, `{"hooks": {"Stop": {}}}`, ""]) {
      sb = sandbox();
      write(sb.userSettings, text);
      const r = await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"]);
      expect(r.code, text).toBe(1);
      expect(r.stderr, text).toMatch(/settings/i);
      expect(read(sb.userSettings)).toBe(text);
      sb.remove();
    }
  });

  it("never prints a secret that is in the settings file", async () => {
    sb = sandbox();
    const token = `${["gh", "p_"].join("")}Zq7Xw2Lr9Kd4Mn8Pv3Ts6Hb1Jc5Gf0Ye2Ua7Rk`;
    write(
      sb.userSettings,
      `${JSON.stringify({ env: { GITHUB_TOKEN: token }, hooks: {} }, null, 2)}\n`,
    );
    const r = await tv(sb, ["install", "claude-code", "--scope", "user", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(token);
  });

  it("never prints a secret whose name and value are on different lines (roborev 5200)", async () => {
    sb = sandbox();
    const secret = "hunter2 correct horse";
    write(
      sb.userSettings,
      // The second copy is spelled with a JSON escape, so a plain text search would miss it.
      `{\n  "env": {\n    "DB_PASSWORD":\n      "${secret}"\n  },\n  "passwords": [\n    "\\u0068unter2 correct horse"\n  ]\n}\n`,
    );
    for (const argv of [
      ["install", "claude-code", "--scope", "user", "--dry-run"],
      ["install", "claude-code", "--scope", "user", "--yes"],
      ["uninstall", "claude-code", "--scope", "user", "--dry-run"],
    ]) {
      const r = await tv(sb, argv);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout + r.stderr, argv.join(" ")).not.toContain("hunter2");
      expect(r.stdout + r.stderr, argv.join(" ")).not.toContain("unter2 correct");
    }
  });

  it("refuses duplicate keys, which JSON.parse would hide, without printing them (roborev 5207, 5210)", async () => {
    for (const text of [
      `{"env": {"DB_PASSWORD": "hunter2 first", "DB_PASSWORD": "second"}}\n`,
      `{"env":{"DB_PASSWORD":\n"hunter2", "DB_PASSWORD":"replacement"}}\n`,
    ]) {
      sb = sandbox();
      write(sb.userSettings, text);
      for (const flag of ["--dry-run", "--yes"]) {
        const r = await tv(sb, ["install", "claude-code", "--scope", "user", flag]);
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/duplicate/i);
        expect(r.stdout + r.stderr).not.toContain("hunter2");
      }
      expect(read(sb.userSettings)).toBe(text);
      sb.remove();
    }
  });

  it("never prints a number under a sensitive key (#194)", async () => {
    sb = sandbox();
    write(
      sb.userSettings,
      `{\n  "env": {\n    "DB_PASSWORD": 987654321987\n  },\n  "auth": {"token": {"pin": 424242}}\n}\n`,
    );
    const r = await tv(sb, ["install", "claude-code", "--scope", "user", "--dry-run"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toContain("987654321987");
    expect(r.stdout).not.toContain("424242");
  });

  it("reinstalls when a user narrowed an installed group with a matcher (roborev 5200)", async () => {
    sb = sandbox();
    await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"]);
    const edited = json(sb.userSettings);
    const pre = (edited.hooks as Hooks).PreToolUse?.[0];
    if (pre === undefined) throw new Error("no PreToolUse group");
    pre.matcher = "Bash";
    writeFileSync(sb.userSettings, `${JSON.stringify(edited, null, 2)}\n`);
    const r = await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/already installed/i);
    const groups = hooksOf(sb.userSettings).PreToolUse ?? [];
    expect(groups.filter((g) => g.hooks.some((h) => String(h.command).includes("shim")))).toEqual([
      { hooks: [expect.objectContaining({ async: true })] },
    ]);
  });

  it("writes through a symlinked settings file (dotfiles) and keeps the link", async () => {
    sb = sandbox();
    const target = join(sb.root, "dotfiles", "claude-settings.json");
    write(target, `{"model": "opus"}\n`);
    mkdirSync(dirname(sb.userSettings), { recursive: true });
    symlinkSync(target, sb.userSettings);
    const r = await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(isLink(sb.userSettings)).toBe(true);
    expect(readlinkSync(sb.userSettings)).toBe(target);
    expect(json(target).model).toBe("opus");
    expect(ours(target)).toHaveLength(EVENTS.length);
  });

  it("uses CLAUDE_CONFIG_DIR when set", async () => {
    sb = sandbox();
    const config = join(sb.root, "claude-config");
    const r = await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"], {
      env: { HOME: sb.home, CLAUDE_CONFIG_DIR: config },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(ours(join(config, "settings.json"))).toHaveLength(EVENTS.length);
    expect(existsSync(sb.userSettings)).toBe(false);
  });

  it("refuses without HOME rather than guess the user's home directory", async () => {
    sb = sandbox();
    const r = await tv(
      sb,
      ["install", "claude-code", "--scope", "user", "--yes", "--home", sb.tv],
      {
        env: {},
      },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/HOME/);
  });

  it("refuses a symlinked shim target in the Taskville home", async () => {
    sb = sandbox();
    const elsewhere = join(sb.root, "elsewhere.sh");
    write(elsewhere, "#!/bin/sh\n");
    mkdirSync(dirname(sb.shim), { recursive: true, mode: 0o700 });
    symlinkSync(elsewhere, sb.shim);
    const r = await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"]);
    expect(r.code).toBe(1);
    expect(read(elsewhere)).toBe("#!/bin/sh\n");
    expect(existsSync(sb.userSettings)).toBe(false);
  });

  it("refuses when the settings file changed between the diff and the answer", async () => {
    sb = sandbox();
    write(sb.userSettings, `{"model": "opus"}\n`);
    const r = await tv(sb, ["install", "claude-code", "--scope", "user"], {
      confirm: async () => {
        writeFileSync(sb.userSettings, `{"model": "sonnet"}\n`);
        return true;
      },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/changed/);
    expect(read(sb.userSettings)).toBe(`{"model": "sonnet"}\n`);
  });
});

describe("hook command", () => {
  it("always sets TASKVILLE_HOME and TASKVILLE_URL, so an inherited value never wins (roborev 5200)", async () => {
    sb = sandbox();
    const r = await tv(
      sb,
      ["install", "claude-code", "--scope", "user", "--yes", "--url", "http://127.0.0.1:4807"],
      {
        env: {
          HOME: sb.home,
          TASKVILLE_URL: "http://127.0.0.1:5555",
          TASKVILLE_HOME: join(sb.root, "other"),
        },
      },
    );
    // --url and the env both given: the flag wins. TASKVILLE_HOME from the env is the home here.
    expect(r.code, r.stderr).toBe(0);
    const command = String(ours(join(sb.home, ".claude", "settings.json"))[0]?.command);
    expect(command).toBe(
      `TASKVILLE_HOME='${join(sb.root, "other")}' TASKVILLE_URL='http://127.0.0.1:4807' '${join(sb.root, "other", "hooks", "taskville-claude-code-shim.sh")}'`,
    );
    // Run under an environment that has other values: the command's assignments win.
    const shim = join(sb.root, "other", "hooks", "taskville-claude-code-shim.sh");
    writeFileSync(shim, `#!/bin/sh\nprintf '%s|%s' "$TASKVILLE_HOME" "$TASKVILLE_URL"\n`);
    const out = execFileSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: { TASKVILLE_URL: "http://127.0.0.1:6666", TASKVILLE_HOME: "/elsewhere" },
    });
    expect(out).toBe(`${join(sb.root, "other")}|http://127.0.0.1:4807`);
  });

  it("quotes a home with spaces, quotes and $ for sh", async () => {
    sb = sandbox();
    const odd = join(sb.root, `it's a "home" $x`);
    const r = await tv(sb, ["install", "claude-code", "--scope", "user", "--yes", "--home", odd]);
    expect(r.code, r.stderr).toBe(0);
    const [hook] = ours(sb.userSettings);
    const command = String(hook?.command);
    // Run the exact command under sh -c with the shim swapped for a probe that prints what it got.
    const shim = join(odd, "hooks", "taskville-claude-code-shim.sh");
    writeFileSync(
      shim,
      `#!/bin/sh\nprintf '%s|%s|%s' "$0" "$TASKVILLE_HOME" "\${TASKVILLE_URL-unset}"\n`,
    );
    const out = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", env: {} });
    expect(out).toBe(`${shim}|${odd}|http://127.0.0.1:4807`);
  });

  it("refuses a URL the shim would never contact", async () => {
    sb = sandbox();
    for (const url of ["http://example.com:4807", "https://127.0.0.1:4807", "http://127.0.0.1"]) {
      const r = await tv(sb, ["install", "claude-code", "--scope", "user", "--yes", "--url", url]);
      expect(r.code, url).toBe(1);
    }
    expect(existsSync(sb.userSettings)).toBe(false);
  });

  it("takes a non-default port from config.json", async () => {
    sb = sandbox();
    write(join(sb.tv, "config.json"), `{"port": 5999}\n`);
    chmodSync(sb.tv, 0o700);
    chmodSync(join(sb.tv, "config.json"), 0o600);
    const r = await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(ours(sb.userSettings)[0]?.command).toBe(commandFor(sb, "http://127.0.0.1:5999"));
  });
});

describe("uninstall", () => {
  it("restores the original byte for byte", async () => {
    sb = sandbox();
    // Odd but valid formatting: 4-space indent, no trailing newline, unusual key order.
    const original = `{\n    "z": 1,\n    "hooks": {\n        "Stop": [{"hooks": [{"type": "command", "command": "x"}]}]\n    },\n    "a": [ ]\n}`;
    write(sb.userSettings, original);
    expect((await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"])).code).toBe(0);
    expect(read(sb.userSettings)).not.toBe(original);
    const r = await tv(sb, ["uninstall", "claude-code", "--scope", "user", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(read(sb.userSettings)).toBe(original);
    expect(existsSync(`${sb.userSettings}.taskville-backup`)).toBe(false);
  });

  it("removes a settings file that install created", async () => {
    sb = sandbox();
    await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"]);
    expect((await tv(sb, ["uninstall", "claude-code", "--scope", "user", "--yes"])).code).toBe(0);
    expect(existsSync(sb.userSettings)).toBe(false);
  });

  it("keeps a formatting-only edit made after install (roborev 5210)", async () => {
    sb = sandbox();
    write(sb.userSettings, `{"model": "opus"}\n`);
    await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"]);
    // Same values, now indented with four spaces.
    writeFileSync(sb.userSettings, `${JSON.stringify(json(sb.userSettings), null, 4)}\n`);
    const r = await tv(sb, ["uninstall", "claude-code", "--scope", "user", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(read(sb.userSettings)).toBe(`{\n    "model": "opus"\n}\n`);
  });

  it("removes only Taskville's entries when the file changed after install", async () => {
    sb = sandbox();
    write(sb.userSettings, `{"model": "opus"}\n`);
    await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"]);
    const edited = json(sb.userSettings);
    edited.model = "sonnet";
    const hooks = edited.hooks as Hooks;
    hooks.Stop?.push({ hooks: [{ type: "command", command: "mine" }] });
    writeFileSync(sb.userSettings, `${JSON.stringify(edited, null, 2)}\n`);
    const r = await tv(sb, ["uninstall", "claude-code", "--scope", "user", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(json(sb.userSettings)).toEqual({
      model: "sonnet",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] },
    });
  });

  it("identifies entries by the shim marker, not by position, and leaves look-alikes", async () => {
    sb = sandbox();
    const lookAlike = { type: "command", command: `${commandFor(sb)} --extra`, async: true };
    write(sb.userSettings, `${JSON.stringify({ hooks: { Stop: [{ hooks: [lookAlike] }] } })}\n`);
    await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"]);
    const r = await tv(sb, ["uninstall", "claude-code", "--scope", "user", "--yes"]);
    expect(r.code).toBe(0);
    expect(json(sb.userSettings)).toEqual({ hooks: { Stop: [{ hooks: [lookAlike] }] } });
  });

  it("says so and changes nothing when nothing is installed", async () => {
    sb = sandbox();
    write(sb.userSettings, `{"model": "opus"}\n`);
    const r = await tv(sb, ["uninstall", "claude-code", "--scope", "user", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/not installed/i);
    expect(read(sb.userSettings)).toBe(`{"model": "opus"}\n`);
  });

  it("prints the diff and asks, like install", async () => {
    sb = sandbox();
    await tv(sb, ["install", "claude-code", "--scope", "user", "--yes"]);
    const r = await tv(sb, ["uninstall", "claude-code", "--scope", "user"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`-    "SessionStart": [`);
    expect(ours(sb.userSettings)).toHaveLength(EVENTS.length);
  });
});

describe("--scope project", () => {
  it("writes .claude/settings.local.json in the project (cwd by default)", async () => {
    sb = sandbox();
    const r = await tv(sb, ["install", "claude-code", "--scope", "project", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(ours(sb.projectSettings)).toHaveLength(EVENTS.length);
    expect(existsSync(sb.userSettings)).toBe(false);
    expect(r.stdout).toMatch(/gitignore/);
  });

  it("takes --project-dir", async () => {
    sb = sandbox();
    const other = join(sb.root, "other project");
    mkdirSync(other);
    const r = await tv(sb, [
      "install",
      "claude-code",
      "--scope",
      "project",
      "--project-dir",
      other,
      "--yes",
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(ours(join(other, ".claude", "settings.local.json"))).toHaveLength(EVENTS.length);
  });

  it("refuses a symlinked .claude directory or settings file (decision #190)", async () => {
    sb = sandbox();
    const target = join(sb.root, "target.json");
    write(target, "{}\n");
    mkdirSync(join(sb.project, ".claude"));
    symlinkSync(target, sb.projectSettings);
    const file = await tv(sb, ["install", "claude-code", "--scope", "project", "--yes"]);
    expect(file.code).toBe(1);
    expect(read(target)).toBe("{}\n");

    sb.remove();
    sb = sandbox();
    const dir = join(sb.root, "real-claude");
    mkdirSync(dir);
    symlinkSync(dir, join(sb.project, ".claude"));
    const linkedDir = await tv(sb, ["install", "claude-code", "--scope", "project", "--yes"]);
    expect(linkedDir.code).toBe(1);
    expect(existsSync(join(dir, "settings.local.json"))).toBe(false);
  });

  it("uninstall restores the project file", async () => {
    sb = sandbox();
    write(sb.projectSettings, `{"permissions": {"deny": []}}\n`);
    await tv(sb, ["install", "claude-code", "--scope", "project", "--yes"]);
    expect((await tv(sb, ["uninstall", "claude-code", "--scope", "project", "--yes"])).code).toBe(
      0,
    );
    expect(read(sb.projectSettings)).toBe(`{"permissions": {"deny": []}}\n`);
  });
});

describe("usage", () => {
  it("requires the claude-code target and a scope", async () => {
    sb = sandbox();
    expect((await tv(sb, ["install"])).code).toBe(1);
    expect((await tv(sb, ["install", "cursor", "--scope", "user"])).code).toBe(1);
    expect((await tv(sb, ["install", "claude-code"])).code).toBe(1);
    expect((await tv(sb, ["install", "claude-code", "--scope", "global"])).code).toBe(1);
  });
});
