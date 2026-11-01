import { afterEach, describe, expect, it } from "vitest";
import type { PairingStore } from "../../src/auth/pairing.ts";
import { CLI_TOKEN, postJson, sessionHeaders } from "../http/helpers.ts";
import {
  BASE,
  BRIDGE_PERMISSION_PATH,
  BRIDGE_TOKEN,
  type BridgeHarness,
  bearer,
  bootBridge,
  eventsOf,
  HOST,
  ORIGIN,
  permissionHook,
  postPermission,
  requestsOf,
  useDbPath,
} from "./helpers.ts";

const dbPath = useDbPath();
let harness: (BridgeHarness & { pairing: PairingStore }) | undefined;
afterEach(() => {
  harness?.bridge.close();
  harness?.engine.close();
  harness = undefined;
});

function boot() {
  harness = bootBridge(dbPath());
  harness.connectViewer();
  return harness;
}

/** Nothing was opened, held, or recorded by a refused request. */
function expectNothingHeld(h: BridgeHarness): void {
  expect(requestsOf(h.engine)).toEqual([]);
  expect(eventsOf(h.engine, "request.opened")).toEqual([]);
  expect(h.scheduler.pending).toBe(0);
}

describe("credentials on the permission route", () => {
  it("rejects a missing token", async () => {
    const h = boot();
    // A valid Host and Origin but no credential: the shared middleware checks Origin first
    // (M1.10 order, as for ingest), so only with both present does the credential check run.
    const res = await postPermission(h.app, permissionHook(), { Host: HOST, Origin: ORIGIN });
    expect(res.status).toBe(401);
    expectNothingHeld(h);
  });

  it("rejects a wrong token, a malformed header, and a token with extra characters", async () => {
    const h = boot();
    for (const headers of [
      bearer(`${BRIDGE_TOKEN}x`),
      bearer("guessed"),
      { Host: HOST, Authorization: BRIDGE_TOKEN },
      { Host: HOST, Authorization: `Basic ${BRIDGE_TOKEN}` },
    ]) {
      const res = await postPermission(h.app, permissionHook(), headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
    }
    expectNothingHeld(h);
  });

  it("rejects the CLI token: it cannot answer or open bridge requests", async () => {
    const h = boot();
    const res = await postPermission(h.app, permissionHook(), bearer(CLI_TOKEN));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "credential_not_allowed", message: expect.any(String) },
    });
    expectNothingHeld(h);
  });

  it("rejects a paired browser session", async () => {
    const h = boot();
    const secret = h.pairing.exchange(h.pairing.issueCode()) ?? "";
    const res = await postPermission(h.app, permissionHook(), {
      ...sessionHeaders(secret),
      Origin: ORIGIN,
    });
    expect(res.status).toBe(403);
    expectNothingHeld(h);
  });

  it("accepts the bridge token only on this route, never on commands or ingest", async () => {
    const h = boot();
    const command = await h.app.request(`${BASE}/v1/commands`, postJson({}, bearer(BRIDGE_TOKEN)));
    expect(command.status).toBe(403);
    const batch = await h.app.request(
      `${BASE}/v1/events/batch`,
      postJson({ events: [] }, bearer(BRIDGE_TOKEN)),
    );
    expect(batch.status).toBe(403);
  });
});

describe("Host and Origin rules, as for other routes", () => {
  it("rejects a Host that is not the loopback address, even with the right token", async () => {
    const h = boot();
    const res = await postPermission(h.app, permissionHook(), {
      Host: "evil.example:4807",
      Authorization: `Bearer ${BRIDGE_TOKEN}`,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "forbidden_host", message: expect.any(String) },
    });
    expectNothingHeld(h);
  });

  it("rejects a request that carries a foreign Origin", async () => {
    const h = boot();
    const res = await postPermission(h.app, permissionHook(), {
      ...bearer(BRIDGE_TOKEN),
      Origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "forbidden_origin", message: expect.any(String) },
    });
    expectNothingHeld(h);
  });

  it("accepts the bridge token with no Origin, as Claude Code's hook sends none", async () => {
    const h = boot();
    const pending = postPermission(h.app, permissionHook());
    // A valid request is held, so it is still pending; release it to finish.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(requestsOf(h.engine).filter((r) => r.answerable && r.state === "open")).toHaveLength(1);
    h.bridge.close();
    expect((await pending).status).toBeLessThan(300);
  });
});

describe("request body", () => {
  it("refuses a body that is not a JSON object, without opening a request", async () => {
    const h = boot();
    for (const body of ["not json", "[]", "null", ""]) {
      const res = await h.app.request(`${BASE}${BRIDGE_PERMISSION_PATH}`, {
        method: "POST",
        headers: { ...bearer(BRIDGE_TOKEN), "Content-Type": "application/json" },
        body,
      });
      expect(res.status, body).toBe(400);
    }
    expectNothingHeld(h);
  });
});
