import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, startServe, tempDir } from "./helpers.ts";

// M2.07 composition: `taskville serve` replays the telemetry spool before it listens, so the
// first snapshot already holds the spooled hooks, marked late, with no needs-you.
const PROMPT = join(
  import.meta.dirname,
  "../../../fixtures/claude-code/permission/notification-permission-prompt.json",
);
const SPOOLED_AT = "2026-10-31T09:15:00Z";

describe("serve replays the Claude Code spool on start", () => {
  const home = tempDir();
  let serve: Awaited<ReturnType<typeof startServe>>;

  beforeAll(async () => {
    const spool = join(home.path, "spool");
    mkdirSync(spool, { recursive: true, mode: 0o700 });
    const { body } = JSON.parse(readFileSync(PROMPT, "utf8")) as {
      body: Record<string, unknown>;
    };
    const line = (payload: unknown, id: string) =>
      `{"payload":${JSON.stringify(payload)},"sourceEventId":"${id}","spooledAt":"${SPOOLED_AT}"}\n`;
    writeFileSync(
      join(spool, "claude-code.jsonl"),
      line(body, "00000000-0000-4000-8000-000000000001") +
        line({ ...body, hook_event_name: "Stop" }, "00000000-0000-4000-8000-000000000002"),
      { mode: 0o600 },
    );
    serve = await startServe(home.path, await freePort(), () => new Date("2026-10-31T12:00:00Z"));
  });
  afterAll(async () => {
    if (serve) expect(await serve.stop()).toBe(0);
    home.remove();
  });

  it("has the spooled hooks in the log before the first request, late and never needs-you", async () => {
    const token = readFileSync(join(home.path, "token"), "utf8").trim();
    const res = await fetch(`${serve.url}/v1/projects/unsorted/snapshot`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const snapshot = (await res.json()) as {
      cursor: number;
      state: { requests: Record<string, { late: boolean; state: string }> };
      attention: { level: string }[];
    };
    expect(snapshot.cursor).toBeGreaterThan(1);
    const requests = Object.values(snapshot.state.requests);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ late: true });
    expect(requests[0]?.state).not.toBe("open");
    expect(snapshot.attention.filter((a) => a.level === "needs_you")).toEqual([]);
    expect(readdirSync(join(home.path, "spool"))).toEqual([]);
    expect(serve.errors()).toContain("spool replayed");
  });
});
