// First-visit pairing (S-3): /pair behind Access, single-use 10 minute codes, session secrets.

import { apiErrorSchema, pairingResponseSchema } from "@taskville/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_HEADER,
  makeStaging,
  ORIGIN,
  pair,
  pairingCodeFrom,
  SESSION_HEADER,
  VALID_JWT,
  withSession,
} from "./support.ts";

function exchange(staging: ReturnType<typeof makeStaging>, code: string) {
  return staging.call("/v1/pairing", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ code }),
  });
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(code);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /pair", () => {
  it("is refused with 403 when there is no Access JWT", async () => {
    const staging = makeStaging();
    const response = await staging.call("/pair");
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });

  it("is refused with 403 when the Access JWT does not verify", async () => {
    const staging = makeStaging();
    const response = await staging.call("/pair", { headers: { [ACCESS_HEADER]: "forged" } });
    expect(response.status).toBe(403);
    expect(staging.verifyAccess).toHaveBeenCalledWith("forged", expect.anything());
  });

  it("does not trust an identity header without the JWT", async () => {
    const staging = makeStaging();
    const response = await staging.call("/pair", {
      headers: { "Cf-Access-Authenticated-User-Email": "owner@example.com" },
    });
    expect(response.status).toBe(403);
  });

  it("redirects 302 to /#pair=<code> when the Access JWT verifies", async () => {
    const staging = makeStaging();
    const response = await staging.call("/pair", { headers: { [ACCESS_HEADER]: VALID_JWT } });
    expect(response.status).toBe(302);
    expect(pairingCodeFrom(response).length).toBeGreaterThanOrEqual(16);
    expect(staging.verifyAccess).toHaveBeenCalledWith(VALID_JWT, expect.anything());
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("mints a fresh code each time", async () => {
    const staging = makeStaging();
    const headers = { [ACCESS_HEADER]: VALID_JWT };
    const a = pairingCodeFrom(await staging.call("/pair", { headers }));
    const b = pairingCodeFrom(await staging.call("/pair", { headers }));
    expect(a).not.toBe(b);
  });
});

describe("POST /v1/pairing", () => {
  it("exchanges a code once for a session secret that opens /v1", async () => {
    const staging = makeStaging();
    const entry = await staging.call("/pair", { headers: { [ACCESS_HEADER]: VALID_JWT } });
    const response = await exchange(staging, pairingCodeFrom(entry));
    expect(response.status).toBe(200);
    const { session } = pairingResponseSchema.parse(await response.json());
    const read = await staging.call("/v1/projects", withSession(session));
    expect(read.status).toBe(200);
  });

  it("refuses a reused code", async () => {
    const staging = makeStaging();
    const code = pairingCodeFrom(
      await staging.call("/pair", { headers: { [ACCESS_HEADER]: VALID_JWT } }),
    );
    expect((await exchange(staging, code)).status).toBe(200);
    await expectError(await exchange(staging, code), 401, "invalid_pairing_code");
  });

  it("redeems a code exactly once under concurrent requests", async () => {
    const staging = makeStaging();
    const code = pairingCodeFrom(
      await staging.call("/pair", { headers: { [ACCESS_HEADER]: VALID_JWT } }),
    );
    const results = await Promise.all(Array.from({ length: 5 }, () => exchange(staging, code)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(4);
  });

  it("refuses a code nobody minted", async () => {
    const staging = makeStaging();
    await expectError(await exchange(staging, "never-minted"), 401, "invalid_pairing_code");
  });

  it("refuses a malformed body with 400", async () => {
    const staging = makeStaging();
    const response = await staging.call("/v1/pairing", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ nope: true }),
    });
    await expectError(response, 400, "bad_request");
  });

  it("expires a code after 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
    const staging = makeStaging();
    const fresh = pairingCodeFrom(
      await staging.call("/pair", { headers: { [ACCESS_HEADER]: VALID_JWT } }),
    );
    const stale = pairingCodeFrom(
      await staging.call("/pair", { headers: { [ACCESS_HEADER]: VALID_JWT } }),
    );
    vi.setSystemTime(new Date("2026-11-06T12:09:59Z"));
    expect((await exchange(staging, fresh)).status).toBe(200);
    vi.setSystemTime(new Date("2026-11-06T12:10:01Z"));
    await expectError(await exchange(staging, stale), 401, "invalid_pairing_code");
  });
});

describe("sessions", () => {
  const routes: [string, string, RequestInit?][] = [
    ["GET", "/health"],
    ["GET", "/v1/projects"],
    ["GET", "/v1/projects/demo/snapshot"],
    ["GET", "/v1/projects/demo/events?after=0"],
    ["GET", "/v1/attention/events"],
    ["GET", "/v1/agents/a1/feed"],
    ["GET", "/v1/evidence/e1"],
    ["POST", "/v1/commands", { body: "{}", headers: { "Content-Type": "application/json" } }],
  ];

  for (const [method, path, init] of routes) {
    it(`${method} ${path} without a session is 401, like the engine`, async () => {
      const staging = makeStaging();
      await expectError(await staging.call(path, { method, ...init }), 401, "unauthorized");
    });
  }

  it("refuses a session secret nobody was issued", async () => {
    const staging = makeStaging();
    await pair(staging);
    const response = await staging.call("/v1/projects", {
      headers: { [SESSION_HEADER]: "not-a-session" },
    });
    await expectError(response, 401, "unauthorized");
  });

  it("does not treat an Access JWT as a session for /v1", async () => {
    const staging = makeStaging();
    const response = await staging.call("/v1/projects", {
      headers: { [ACCESS_HEADER]: VALID_JWT },
    });
    await expectError(response, 401, "unauthorized");
  });
});
