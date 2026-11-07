// Session lifetime, revocation and what minting scans.

import { apiErrorSchema, pairingRevokeResponseSchema } from "@taskville/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSON_POST, makeStaging, pair, withSession } from "./support.ts";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-11-06T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

const sessionKeys = (staging: ReturnType<typeof makeStaging>) =>
  [...staging.pairing.map.keys()].filter((key) => key.startsWith("session:"));

describe("session lifetime", () => {
  it("works up to 30 days", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    vi.setSystemTime(START + 30 * DAY - 1000);
    expect((await staging.call("/v1/projects", withSession(session))).status).toBe(200);
  });

  it("is refused after 30 days, and deleted", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    expect(sessionKeys(staging)).toHaveLength(1);
    vi.setSystemTime(START + 30 * DAY + 1000);
    const response = await staging.call("/v1/projects", withSession(session));
    expect(response.status).toBe(401);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe("unauthorized");
    expect(sessionKeys(staging)).toHaveLength(0);
  });
});

describe("POST /v1/pairing/revoke", () => {
  it("revokes the caller's session and only that one", async () => {
    const staging = makeStaging();
    const mine = await pair(staging);
    const other = await pair(staging);
    const response = await staging.call(
      "/v1/pairing/revoke",
      withSession(mine, { method: "POST", headers: JSON_POST }),
    );
    expect(response.status).toBe(200);
    expect(pairingRevokeResponseSchema.parse(await response.json())).toEqual({ revoked: 1 });
    expect((await staging.call("/v1/projects", withSession(mine))).status).toBe(401);
    expect((await staging.call("/v1/projects", withSession(other))).status).toBe(200);
  });

  it("needs a session and this site's Origin", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const anonymous = await staging.call("/v1/pairing/revoke", {
      method: "POST",
      headers: JSON_POST,
    });
    expect(anonymous.status).toBe(401);
    const noOrigin = await staging.call(
      "/v1/pairing/revoke",
      withSession(session, { method: "POST" }),
    );
    expect(noOrigin.status).toBe(403);
    const foreign = await staging.call(
      "/v1/pairing/revoke",
      withSession(session, { method: "POST", headers: { Origin: "https://evil.example" } }),
    );
    expect(foreign.status).toBe(403);
    expect((await staging.call("/v1/projects", withSession(session))).status).toBe(200);
  });
});

describe("minting codes", () => {
  it("lists only the code prefix, never sessions", async () => {
    const staging = makeStaging();
    await pair(staging);
    await pair(staging);
    for (const options of staging.pairing.listCalls) expect(options?.prefix).toBe("code:");
  });

  it("still sweeps expired codes", async () => {
    const staging = makeStaging();
    await staging.call("/pair", { headers: { "Cf-Access-Jwt-Assertion": "valid-access-jwt" } });
    const codeKeys = () => [...staging.pairing.map.keys()].filter((k) => k.startsWith("code:"));
    expect(codeKeys()).toHaveLength(1);
    vi.setSystemTime(START + 11 * 60 * 1000);
    await staging.call("/pair", { headers: { "Cf-Access-Jwt-Assertion": "valid-access-jwt" } });
    expect(codeKeys()).toHaveLength(1);
  });
});
