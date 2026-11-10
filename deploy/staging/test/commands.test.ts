// POST /v1/commands validates the whole command like the engine (apps/engine/src/commands).

import { describe, expect, it } from "vitest";
import { JSON_POST, makeStaging, pair, withSession } from "./support.ts";

const valid = {
  type: "permission.decide",
  projectId: "demo",
  requestId: "r1",
  idempotencyKey: "k1",
  context: { mode: "live" },
  decision: { behavior: "allow" },
};

async function send(body: unknown) {
  const staging = makeStaging();
  const session = await pair(staging);
  const response = await staging.call(
    "/v1/commands",
    withSession(session, {
      method: "POST",
      headers: JSON_POST,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as { error: { code: string } } };
}

describe("POST /v1/commands", () => {
  it("answers a valid permission command for the demo project 410 request_expired", async () => {
    const result = await send(valid);
    expect(result.status).toBe(410);
    expect(result.body.error.code).toBe("request_expired");
  });

  it("answers an unknown project 404 unknown_project", async () => {
    const result = await send({ ...valid, projectId: "no-such-project" });
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("unknown_project");
  });

  it("accepts deny with a note", async () => {
    const result = await send({ ...valid, decision: { behavior: "deny", message: "no" } });
    expect(result.status).toBe(410);
  });

  it("refuses a command with no decision", async () => {
    const { decision: _decision, ...rest } = valid;
    const result = await send(rest);
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("bad_request");
  });

  it("refuses a decision that is neither allow nor deny", async () => {
    expect((await send({ ...valid, decision: { behavior: "always" } })).status).toBe(400);
  });

  it("refuses a deny note over 1000 characters", async () => {
    const decision = { behavior: "deny", message: "x".repeat(1001) };
    expect((await send({ ...valid, decision })).status).toBe(400);
  });

  it("refuses a command from history with the engine's code", async () => {
    const result = await send({ ...valid, context: { mode: "history" } });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("history_context_rejected");
  });

  it("refuses an unknown context mode", async () => {
    expect((await send({ ...valid, context: { mode: "ambient" } })).status).toBe(400);
  });

  it("refuses unknown keys, as the engine's strict schema does", async () => {
    expect((await send({ ...valid, cwd: "/tmp" })).status).toBe(400);
    expect((await send({ ...valid, decision: { behavior: "allow", extra: 1 } })).status).toBe(400);
  });

  it("refuses a body that is not JSON, and an unknown type", async () => {
    expect((await send("not json")).status).toBe(400);
    expect((await send({ ...valid, type: "shell.run" })).status).toBe(400);
  });

  it("refuses session.open without a session id", async () => {
    const { decision: _decision, ...rest } = valid;
    const result = await send({ ...rest, type: "session.open" });
    expect(result.status).toBe(400);
  });
});
