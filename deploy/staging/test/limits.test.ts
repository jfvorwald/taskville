// Request limits, Origin refusal on state-changing routes, and the 400 and 413 paths.

import { apiErrorSchema } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { JSON_POST, makeStaging, ORIGIN, pair, withSession } from "./support.ts";

const command = {
  type: "permission.decide",
  projectId: "demo",
  requestId: "r1",
  idempotencyKey: "k1",
  context: { mode: "live" },
  decision: { behavior: "allow" },
};

async function errorOf(response: Response) {
  return apiErrorSchema.parse(await response.json()).error.code;
}

/** A POST whose declared length is over the cap, with a body that must never be read. */
function unreadBody(contentLength: number, headers: Record<string, string>) {
  const state = { pulled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulled = true;
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const init = {
    method: "POST",
    headers: { ...headers, "Content-Length": String(contentLength) },
    body,
    duplex: "half",
  } as RequestInit;
  return { state, init };
}

describe("Content-Length over the cap", () => {
  it("is refused 413 on /v1/commands before the body is read", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const { state, init } = unreadBody(10_000_000, JSON_POST);
    const response = await staging.call("/v1/commands", withSession(session, init));
    expect(response.status).toBe(413);
    expect(await errorOf(response)).toBe("payload_too_large");
    expect(state.pulled).toBe(false);
  });

  it("is refused 413 on /v1/pairing before the body is read", async () => {
    const staging = makeStaging();
    const { state, init } = unreadBody(5000, JSON_POST);
    const response = await staging.call("/v1/pairing", init);
    expect(response.status).toBe(413);
    expect(await errorOf(response)).toBe("payload_too_large");
    expect(state.pulled).toBe(false);
    expect(staging.pairing.stubCalls).toHaveLength(0);
  });
});

describe("pairing codes", () => {
  const exchange = (staging: ReturnType<typeof makeStaging>, code: string) =>
    staging.call("/v1/pairing", {
      method: "POST",
      headers: JSON_POST,
      body: JSON.stringify({ code }),
    });

  const malformed = [
    "short",
    "a".repeat(42),
    "a".repeat(44),
    `${"a".repeat(42)}+`,
    `${"a".repeat(42)}/`,
    `${"a".repeat(42)}=`,
    `${"a".repeat(42)} `,
    `${"a".repeat(41)}éé`,
  ];
  for (const code of malformed) {
    it(`refuses ${JSON.stringify(code)} without reaching the Durable Object`, async () => {
      const staging = makeStaging();
      const response = await exchange(staging, code);
      expect([400, 401]).toContain(response.status);
      expect(["bad_request", "invalid_pairing_code"]).toContain(await errorOf(response));
      expect(staging.pairing.stubCalls).toHaveLength(0);
    });
  }

  it("sends a well-formed code on to the Durable Object, which refuses an unminted one", async () => {
    const staging = makeStaging();
    const response = await exchange(staging, "A".repeat(43));
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toBe("invalid_pairing_code");
    expect(staging.pairing.stubCalls).toHaveLength(1);
  });
});

describe("Origin on state-changing POSTs", () => {
  const foreign = { "Content-Type": "application/json", Origin: "https://evil.example" };
  const noOrigin = { "Content-Type": "application/json" };

  it("/v1/commands refuses a missing and a foreign Origin with 403", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    for (const headers of [noOrigin, foreign]) {
      const response = await staging.call(
        "/v1/commands",
        withSession(session, { method: "POST", headers, body: JSON.stringify(command) }),
      );
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toBe("forbidden_origin");
    }
  });

  it("/v1/pairing refuses a missing and a foreign Origin with 403", async () => {
    const staging = makeStaging();
    for (const headers of [noOrigin, foreign]) {
      const response = await staging.call("/v1/pairing", {
        method: "POST",
        headers,
        body: JSON.stringify({ code: "A".repeat(43) }),
      });
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toBe("forbidden_origin");
    }
    expect(staging.pairing.stubCalls).toHaveLength(0);
  });

  it("accepts this site's own Origin", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const response = await staging.call(
      "/v1/commands",
      withSession(session, {
        method: "POST",
        headers: { ...noOrigin, Origin: ORIGIN },
        body: JSON.stringify(command),
      }),
    );
    expect(response.status).not.toBe(403);
  });
});

describe("400 and 413 on the body routes", () => {
  it("/v1/pairing: not JSON and a missing code are 400, an oversized body is 413", async () => {
    const staging = makeStaging();
    const post = (body: string) =>
      staging.call("/v1/pairing", { method: "POST", headers: JSON_POST, body });
    const notJson = await post("nope");
    expect(notJson.status).toBe(400);
    expect(await errorOf(notJson)).toBe("bad_request");
    expect((await post("{}")).status).toBe(400);
    const big = await post(JSON.stringify({ code: "A".repeat(2000) }));
    expect(big.status).toBe(413);
    expect(await errorOf(big)).toBe("payload_too_large");
  });

  it("/v1/commands: not JSON is 400, an oversized body is 413", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const post = (body: string) =>
      staging.call(
        "/v1/commands",
        withSession(session, { method: "POST", headers: JSON_POST, body }),
      );
    const notJson = await post("nope");
    expect(notJson.status).toBe(400);
    expect(await errorOf(notJson)).toBe("bad_request");
    const big = await post(JSON.stringify({ ...command, padding: "x".repeat(20_000) }));
    expect(big.status).toBe(413);
    expect(await errorOf(big)).toBe("payload_too_large");
  });
});
