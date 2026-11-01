import { afterEach, describe, expect, it } from "vitest";
import {
  bootHarness,
  commandEvents,
  decideBody,
  type Harness,
  REQUEST_ID,
  useDbPath,
} from "./helpers.ts";

// M4.03 review fix (security L3, L4). The deny note reaches the agent's hook response, so:
//   - an empty or whitespace-only note (or one that is only control characters) is treated as
//     absent: the hook gets "Denied in Taskville", and the audit payload of command.requested has
//     no noteDigest, exactly as for a deny with no note;
//   - C0 and C1 control characters (U+0000-U+001F, U+007F-U+009F) are stripped from the note
//     before it reaches the hook response, except \n and \t, which stay. The rest of the note is
//     passed unchanged (the printable remainder of an escape sequence stays).

const dbPath = useDbPath();
let harness: Harness | undefined;
afterEach(() => {
  harness?.engine.close();
  harness = undefined;
});

function boot(): Harness {
  harness = bootHarness(dbPath());
  return harness;
}

describe("permission.decide: a deny note that is blank counts as absent", () => {
  for (const [name, message] of [
    ["empty", ""],
    ["spaces", "   "],
    ["whitespace including newlines and tabs", " \n\t \n"],
    ["only control characters", "\u0000\u0007\u001b\u007f\u0085"],
  ] as const) {
    it(`sends 'Denied in Taskville' for a ${name} note and records no note digest`, async () => {
      const h = boot();
      const res = await h.post(decideBody({ decision: { behavior: "deny", message } }));
      expect(res.status).toBe(200);
      expect(h.bridge.decide).toHaveBeenCalledTimes(1);
      expect(h.bridge.decide).toHaveBeenCalledWith(REQUEST_ID, {
        behavior: "deny",
        message: "Denied in Taskville",
      });
      const requested = commandEvents(h.engine)[0]?.payload as {
        payload: { decision: Record<string, unknown> };
      };
      expect(requested.payload.decision).toEqual({ behavior: "deny" });
    });
  }
});

describe("permission.decide: control characters are stripped from the deny note", () => {
  it("strips C0, DEL, and C1 controls but keeps newline and tab", async () => {
    const h = boot();
    const message = "a\u0000b\u001b[31mred\u0007\r\nline2\tx\u007fy\u0085z\u009fw";
    const res = await h.post(decideBody({ decision: { behavior: "deny", message } }));
    expect(res.status).toBe(200);
    expect(h.bridge.decide).toHaveBeenCalledWith(REQUEST_ID, {
      behavior: "deny",
      message: "ab[31mred\nline2\txyzw",
    });
  });

  it("leaves an ordinary note, accents and emoji included, unchanged", async () => {
    const h = boot();
    const message = "Nicht jetzt, bitte: café \u{1F600}\nzweite Zeile";
    const res = await h.post(decideBody({ decision: { behavior: "deny", message } }));
    expect(res.status).toBe(200);
    expect(h.bridge.decide).toHaveBeenCalledWith(REQUEST_ID, { behavior: "deny", message });
  });
});
