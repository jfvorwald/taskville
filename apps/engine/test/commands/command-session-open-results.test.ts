import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootHarness,
  type Harness,
  json,
  openBody,
  requestOpened,
  SESSION_ID,
  sessionStarted,
  useDbPath,
} from "./helpers.ts";

// M4.03 review fix (code review 4-6). A session.open `result` ({ outcome, sessionId, cwd }) is
// not in the log, so the service remembers it per process:
//   - a replay (same key) and GET /v1/commands/:id in the same process carry the `result`;
//   - the memory is bounded: past `maxRememberedResults` (service option, default 500) the
//     OLDEST command's result is forgotten first. A forgotten result leaves the command
//     `succeeded` with no `result` property, as after a restart.

const dbPath = useDbPath();
let harness: Harness | undefined;
let root = "";
let cwd = "";
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "taskville-open-res-")));
  cwd = join(root, "repo");
  mkdirSync(cwd);
});
afterEach(() => {
  harness?.engine.close();
  harness = undefined;
  rmSync(root, { recursive: true, force: true });
});

const TEMPLATE = ["/usr/bin/open", "-a", "Terminal", "{cwd}", "--id={sessionId}"];

describe("session.open: the result in the same process", () => {
  it("carries the result on the POST, on a replay of its key, and on GET", async () => {
    harness = bootHarness(dbPath(), {
      sessionOpener: TEMPLATE,
      roots: [root],
      seed: [sessionStarted(cwd), requestOpened({})],
    });
    const h = harness;
    const result = { outcome: "opened", sessionId: SESSION_ID, cwd };
    const first = (await json(await h.post(openBody()))).command;
    expect(first?.result).toEqual(result);

    const replay = await h.post(openBody());
    expect(replay.status).toBe(200);
    expect((await json(replay)).command).toMatchObject({ id: first?.id, result });

    const got = await json(await h.get(first?.id ?? ""));
    expect(got.command).toMatchObject({ id: first?.id, status: "succeeded", result });
  });

  it("forgets the oldest result first once maxRememberedResults is exceeded", async () => {
    const sessions = ["s1", "s2", "s3"];
    const seed = sessions.flatMap((id) => {
      const dir = join(root, id);
      mkdirSync(dir);
      return [
        sessionStarted(dir, id, `agent-${id}`),
        requestOpened({ requestId: `req-${id}`, sessionId: id, agentId: `agent-${id}` }),
      ];
    });
    harness = bootHarness(dbPath(), {
      sessionOpener: TEMPLATE,
      roots: [root],
      seed,
      serviceExtras: { maxRememberedResults: 2 },
    });
    const h = harness;
    const ids: string[] = [];
    for (const id of sessions) {
      const res = await h.post(
        openBody({ sessionId: id, requestId: `req-${id}`, idempotencyKey: `open-${id}` }),
      );
      expect(res.status).toBe(200);
      ids.push((await json(res)).command?.id ?? "");
    }

    const views = await Promise.all(ids.map(async (id) => (await json(await h.get(id))).command));
    // The first command is the oldest: succeeded, but its result is forgotten.
    expect(views[0]).toMatchObject({ id: ids[0], status: "succeeded" });
    expect(views[0]).not.toHaveProperty("result");
    // The two newest keep theirs.
    expect(views[1]?.result).toMatchObject({ sessionId: "s2" });
    expect(views[2]?.result).toMatchObject({ sessionId: "s3" });

    // A replay of the forgotten command is still the same command and runs nothing again.
    const replay = await h.post(
      openBody({ sessionId: "s1", requestId: "req-s1", idempotencyKey: "open-s1" }),
    );
    expect(replay.status).toBe(200);
    expect((await json(replay)).command).toMatchObject({ id: ids[0], status: "succeeded" });
    expect(h.execFile).toHaveBeenCalledTimes(3);
  });
});
