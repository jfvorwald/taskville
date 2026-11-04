import { describe, expect, it } from "vitest";
import { buildEditorLink, DEFAULT_EDITOR_TEMPLATE } from "./editorLink.ts";

// M5.09 red: editor links come from a fixed template with the path encoded (ARCHITECTURE 13).

describe("buildEditorLink", () => {
  it("uses the vscode template by default", () => {
    expect(DEFAULT_EDITOR_TEMPLATE).toBe("vscode://file{path}");
    expect(buildEditorLink("/Users/me/app/src/a.ts")).toBe("vscode://file/Users/me/app/src/a.ts");
  });

  it("encodes spaces, unicode, #, ?, %, and newline per segment but keeps the slashes", () => {
    expect(buildEditorLink("/Users/me/my proj/caf\u00e9 #1?.ts")).toBe(
      "vscode://file/Users/me/my%20proj/caf%C3%A9%20%231%3F.ts",
    );
    expect(buildEditorLink("/tmp/100%/a\nb.ts")).toBe("vscode://file/tmp/100%25/a%0Ab.ts");
  });

  it("appends a line number when given a positive integer, and ignores a bad one", () => {
    expect(buildEditorLink("/a/b.ts", { line: 12 })).toBe("vscode://file/a/b.ts:12");
    expect(buildEditorLink("/a/b.ts", { line: -3 })).toBe("vscode://file/a/b.ts");
    expect(buildEditorLink("/a/b.ts", { line: Number.NaN })).toBe("vscode://file/a/b.ts");
  });

  it("rejects dot-dot segments, relative paths, empty paths, and NUL", () => {
    expect(buildEditorLink("/Users/me/../../etc/passwd")).toBeNull();
    expect(buildEditorLink("/a/%2e%2e/b")).toBe("vscode://file/a/%252e%252e/b");
    expect(buildEditorLink("src/a.ts")).toBeNull();
    expect(buildEditorLink("")).toBeNull();
    expect(buildEditorLink("/a/b\u0000.ts")).toBeNull();
  });

  it("accepts other editor schemes from a template with {path}", () => {
    expect(buildEditorLink("/a/b.ts", { template: "cursor://file{path}" })).toBe(
      "cursor://file/a/b.ts",
    );
    expect(buildEditorLink("/a/b.ts", { template: "idea://open?file={path}" })).toBe(
      "idea://open?file=/a/b.ts",
    );
  });

  it.each([
    "javascript:alert(1)//{path}",
    "JaVaScRiPt:alert(1)//{path}",
    " javascript:{path}",
    "data:text/html,{path}",
    "vbscript:{path}",
    "https://evil.example{path}",
    "http://evil.example{path}",
    "file://{path}",
    "blob:{path}",
    "//evil.example{path}",
    "vscode://file/fixed-path-without-placeholder",
    "",
  ])("rejects the unsafe or malformed template %j", (template) => {
    expect(buildEditorLink("/a/b.ts", { template })).toBeNull();
  });

  it("never emits whitespace, control, or non-ASCII characters", () => {
    const nasty = [
      "/a/\u202e.ts",
      "/a/\u200b.ts",
      "/a/\r\n.ts",
      "/a/\u00e9\u{1f600}.ts",
      "/a/ \t.ts",
    ];
    for (const path of nasty) {
      const url = buildEditorLink(path);
      expect(url).not.toBeNull();
      expect(url as string).toMatch(/^vscode:\/\/file\/[\x21-\x7e]*$/);
    }
  });
});
