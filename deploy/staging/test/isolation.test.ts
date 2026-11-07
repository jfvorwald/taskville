// Isolation (ARCHITECTURE.md section 13, S-3): no bridge, no agent, no proxy, no outbound call.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeStaging, ORIGIN, pair, withSession } from "./support.ts";

let outbound: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("outbound fetch from the staging Worker");
  });
});

afterEach(() => {
  outbound.mockRestore();
});

const json = { "Content-Type": "application/json", Origin: ORIGIN };

describe("staging isolation", () => {
  it("answers a permission command with the engine's expired answer and reaches nothing", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const response = await staging.call(
      "/v1/commands",
      withSession(session, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          type: "permission.decide",
          projectId: "demo",
          requestId: "r1",
          idempotencyKey: "k1",
          context: { mode: "live" },
          decision: { behavior: "allow" },
        }),
      }),
    );
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "request_expired",
    );
    expect(outbound).toHaveBeenCalledTimes(0);
  });

  it("answers session.open with a client error, never success, and reaches nothing", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const response = await staging.call(
      "/v1/commands",
      withSession(session, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          type: "session.open",
          projectId: "demo",
          requestId: "r2",
          sessionId: "s1",
          idempotencyKey: "k2",
          context: { mode: "live" },
        }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(typeof ((await response.json()) as { error: { code: unknown } }).error.code).toBe(
      "string",
    );
    expect(outbound).toHaveBeenCalledTimes(0);
  });

  it("answers GET /v1/requests/:id/input with 410 request_expired and reaches nothing", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const response = await staging.call(
      "/v1/requests/r1/input?projectId=demo",
      withSession(session),
    );
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "request_expired",
    );
    expect(outbound).toHaveBeenCalledTimes(0);
  });

  it("has no route that proxies: unknown paths are 404 and nothing leaves the Worker", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const attempts = [
      "/v1/proxy?url=https://example.com/",
      "/v1/forward/https://example.com/",
      "/v1/hooks/permission-request",
      "/v1/events/batch",
      "/v1/projects/demo/proxy",
    ];
    for (const path of attempts) {
      for (const method of ["GET", "POST"]) {
        const response = await staging.call(
          path,
          withSession(session, {
            method,
            headers: json,
            ...(method === "POST" ? { body: JSON.stringify({ url: "https://example.com/" }) } : {}),
          }),
        );
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    }
    expect(outbound).toHaveBeenCalledTimes(0);
  });

  it("makes no outbound call while serving the whole read surface", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const paths = [
      "/health",
      "/v1/projects",
      "/v1/projects/demo/snapshot",
      "/v1/projects/demo/timelines",
      "/v1/agents/a1/cost",
      "/v1/evidence/e1",
      "/",
    ];
    for (const path of paths) {
      const response = await staging.call(path, withSession(session));
      await response.arrayBuffer();
    }
    expect(outbound).toHaveBeenCalledTimes(0);
  });
});
