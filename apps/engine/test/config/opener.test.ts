import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../src/config/config.ts";
import { renderOpener } from "../../src/config/opener.ts";

const ctx = { homedir: "/home/user", rootExists: () => true };

function openerIssues(sessionOpener: unknown): string {
  try {
    parseConfig({ sessionOpener }, ctx);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues.join("\n");
    throw err;
  }
  return "";
}

describe("session opener template", () => {
  it("accepts an argument array with known placeholders", () => {
    const opener = ["/usr/bin/open", "-a", "Terminal", "{cwd}"];
    expect(parseConfig({ sessionOpener: opener }, ctx).config.sessionOpener).toEqual(opener);
  });

  it("rejects a shell command string, explaining the array form", () => {
    expect(openerIssues("open -a Terminal {cwd}")).toMatch(/^sessionOpener: .*array/);
  });

  it("rejects an empty array and non-string or empty arguments", () => {
    expect(openerIssues([])).toMatch(/^sessionOpener/);
    expect(openerIssues(["open", 3])).toMatch(/^sessionOpener\[1\]/);
    expect(openerIssues(["open", ""])).toMatch(/^sessionOpener\[1\]/);
    expect(openerIssues(["open", "a\u0000b"])).toMatch(/^sessionOpener\[1\]/);
  });

  it("never lets a placeholder choose the program", () => {
    expect(openerIssues(["{cwd}/run"])).toMatch(/^sessionOpener\[0\]: .*placeholder/);
  });

  it("rejects unknown placeholders, listing the known ones", () => {
    expect(openerIssues(["open", "{command}"])).toMatch(
      /^sessionOpener\[1\]: .*\{command\}.*\{sessionId\}.*\{cwd\}/,
    );
  });

  it("refuses shells and command launchers as the program", () => {
    for (const program of [
      "sh",
      "/bin/bash",
      "zsh",
      "/usr/bin/env",
      "fish",
      "pwsh",
      "cmd.exe",
      "powershell.exe",
      "osascript",
      "node",
      "python3",
    ]) {
      expect(openerIssues([program, "{cwd}"]), program).toMatch(/^sessionOpener\[0\]: .*shell/);
    }
  });
});

describe("renderOpener", () => {
  it("returns the program and arguments with placeholders filled in literally", () => {
    expect(
      renderOpener(["open", "vscode://file{cwd}", "--session={sessionId}"], {
        cwd: "/src/tv",
        sessionId: "s-1",
      }),
    ).toEqual({ file: "open", args: ["vscode://file/src/tv", "--session=s-1"] });
  });

  it("keeps hostile values inside a single argument", () => {
    const { args } = renderOpener(["open", "{cwd}"], {
      cwd: "/tmp/x; rm -rf ~ $(whoami) {sessionId}",
      sessionId: "s",
    });
    expect(args).toEqual(["/tmp/x; rm -rf ~ $(whoami) {sessionId}"]);
  });
});
