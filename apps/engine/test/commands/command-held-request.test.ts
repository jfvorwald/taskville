import { afterEach, describe, expect, it } from "vitest";
import {
  bootHarness,
  commandEvents,
  decideBody,
  type Harness,
  json,
  PROJECT,
  REQUEST_ID,
  SESSION_ID,
  types,
  useDbPath,
} from "./helpers.ts";

// M4.03 review fix (security M2). permission.decide answers a hook response, so the request the
// bridge holds under `requestId` must be the one the command names: `bridge.lookup(requestId)`
// must match `body.projectId` and the recorded request's `sessionId`. A mismatch takes the
// request_expired path (410, command.requested then command.expired) and `decide` is never
// called, so a decision cannot reach another project's or another session's hook response.

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

const held = (overrides: Record<string, unknown>) => ({
  requestId: REQUEST_ID,
  projectId: PROJECT,
  sessionId: SESSION_ID,
  toolName: "Bash",
  toolInput: { command: "ls" },
  ...overrides,
});

describe("permission.decide: the held request must be the command's own", () => {
  it("delivers when the held request matches the project and the recorded session", async () => {
    const h = boot();
    h.bridge.lookup.mockReturnValue(held({}));
    const res = await h.post(decideBody());
    expect(res.status).toBe(200);
    expect(h.bridge.decide).toHaveBeenCalledTimes(1);
  });

  for (const [name, overrides] of [
    ["another project", { projectId: "other-project" }],
    ["another session", { sessionId: "sess-other" }],
  ] as const) {
    it(`treats a request held for ${name} as expired and never calls decide`, async () => {
      const h = boot();
      h.bridge.lookup.mockReturnValue(held(overrides));
      const res = await h.post(decideBody());
      expect(res.status).toBe(410);
      const body = await json(res);
      expect(body.error?.code).toBe("request_expired");
      expect(body.command?.status).toBe("expired");
      expect(h.bridge.decide).not.toHaveBeenCalled();
      expect(types(commandEvents(h.engine))).toEqual(["command.requested", "command.expired"]);
    });
  }
});
