import { describe, expect, it, vi } from "vitest";
import { openSession } from "../../src/commands/open-session.ts";

// Pins shipped M4.08 behavior (d6f28fc): the directory check applies only when the opener template
// uses {cwd}. A template without it needs no directory, so a failing isDirectory must not block it.
// This test passes on the M4.08 code; it guards the fix against regression.

describe("openSession: directory check applies only to templates that use {cwd}", () => {
  it("still runs the opener when the template has no {cwd} and isDirectory says false", async () => {
    const execFile = vi.fn(async () => undefined);
    const isDirectory = vi.fn(async (_path: string) => false);
    const result = await openSession(
      { sessionId: "sess-1", cwd: "/Users/dev/repo" },
      { config: { sessionOpener: ["open", "--id={sessionId}"] }, execFile, isDirectory },
    );
    expect(result).toEqual({ status: "opened", sessionId: "sess-1", cwd: "/Users/dev/repo" });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]).toEqual(["open", ["--id=sess-1"], expect.any(Object)]);
    expect(isDirectory).not.toHaveBeenCalled();
  });
});
