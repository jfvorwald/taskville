import { expect, it } from "vitest";
import { wirePermissionBridge } from "../../src/bridge/wire.ts";
import { bearer, CLI_TOKEN } from "../http/helpers.ts";
import { fixedNow } from "../ingest/helpers.ts";
import {
  BASE,
  bootInProcess,
  input,
  SseReader,
  streamRequest,
  useDbPath,
} from "../stream/helpers.ts";
import { AGENT, ManualScheduler, permissionHook, postPermission, SESSION } from "./helpers.ts";

const dbPath = useDbPath();

// M4.14 (#290): a bridge commit reaches the project stream but must also update an already
// connected global attention viewer. A fresh snapshot alone would miss the broken live path.
it("publishes an unsorted bridge-held permission to the connected global attention feed", async () => {
  const { app, engine } = bootInProcess(dbPath(), { now: fixedNow });
  const scheduler = new ManualScheduler();
  const wired = wirePermissionBridge({
    app,
    engine,
    config: {
      bridge: { holdWindowSeconds: 3, hookTimeoutSeconds: 8 },
      sessionOpener: null,
    },
    now: fixedNow,
    schedule: scheduler.schedule,
  });
  const readers: SseReader[] = [];
  let pending: Promise<Response> | undefined;
  try {
    // No configured root covers the hook cwd, as in the M4.10 replay harness. Register the
    // session without a PermissionRequest telemetry event that could mask a missed bridge update.
    engine.pipeline.ingest([
      input("unsorted-session", {
        projectId: "unsorted",
        type: "agent.registered",
        sourceId: "claude-code",
        agentId: AGENT,
        sessionId: SESSION,
        occurredAt: fixedNow().toISOString(),
        payload: { sourceAgentId: SESSION, displayName: "proj", role: "main", kind: "session" },
      }),
    ]);
    const response = await app.request(`${BASE}/v1/attention/events`, {
      headers: bearer(CLI_TOKEN),
    });
    expect(response.status).toBe(200);
    const feed = new SseReader(response);
    readers.push(feed);
    expect(await feed.next()).toMatchObject({ event: "snapshot", data: { projects: [] } });

    // A real project SSE subscriber makes the hook answerable and receives the red-row event.
    const viewer = new SseReader(await streamRequest(app, "unsorted", bearer(CLI_TOKEN)));
    readers.push(viewer);
    await viewer.events(2); // project.created and agent.registered backlog
    pending = postPermission(app, permissionHook());
    const [opened] = await viewer.events(1);
    expect(opened?.data).toMatchObject({
      type: "request.opened",
      projectId: "unsorted",
      agentId: AGENT,
      sourceId: "taskville:bridge",
    });
    expect(scheduler.pending).toBe(1); // Still held, not fallen through or decided.

    const project = {
      projectId: "unsorted",
      attention: [
        expect.objectContaining({ agentId: AGENT, level: "needs_you", kind: "permission" }),
      ],
    };
    // The committed project already computes needs_you. Do not reconnect the global feed here:
    // subscribing refreshes all projects and would repair the very missed update under test.
    const snapshot = await app.request(`${BASE}/v1/projects/unsorted/snapshot`, {
      headers: bearer(CLI_TOKEN),
    });
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({ attention: project.attention });

    // Existing viewers must learn about the commit without reconnecting or waiting for the
    // 30-second heuristic tick, which is longer than the replay's entire three-second hold.
    expect(await feed.next()).toMatchObject({ event: "attention", data: project });
  } finally {
    wired.close();
    await pending;
    for (const reader of readers) await reader.cancel();
    engine.close();
  }
});
