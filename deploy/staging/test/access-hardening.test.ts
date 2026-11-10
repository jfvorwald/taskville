// Access hardening: an allowed identity, a pinned team domain, negative caching, a fetch timeout,
// and the key cache's clock rules (an hour of life, one refetch a minute for an unknown kid).

import { describe, expect, it, vi } from "vitest";
import { createAccessVerifier } from "../src/access.ts";
import {
  AUD,
  DOMAIN,
  ENV,
  good,
  jwkOf,
  type KeyPair,
  keyPair,
  NOW,
  NOW_MS,
  sign,
} from "./access-support.ts";
import { ACCESS_HEADER, makeStaging, VALID_JWT } from "./support.ts";

const MINUTE = 60 * 1000;
const longLived = { ...good, exp: NOW + 7 * 24 * 3600 };

type Init = { signal?: AbortSignal } | undefined;

function clock(start = NOW_MS) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function withKeys(...kids: string[]) {
  const pairs = new Map<string, KeyPair>();
  for (const kid of kids) pairs.set(kid, await keyPair());
  const jwks = async (list: string[]) =>
    Response.json({
      keys: await Promise.all(list.map((kid) => jwkOf(pairs.get(kid) as KeyPair, kid))),
    });
  const token = (kid: string, claims: Record<string, unknown> = longLived) =>
    sign((pairs.get(kid) as KeyPair).privateKey, claims, { alg: "RS256", kid, typ: "JWT" });
  return { jwks, token };
}

describe("ACCESS_ALLOWED_EMAIL at /pair", () => {
  const pairWith = (extra: Record<string, unknown>) => {
    const staging = makeStaging();
    return staging.callWith(extra, "/pair", { headers: { [ACCESS_HEADER]: VALID_JWT } });
  };

  it("refuses an identity other than the allowed one", async () => {
    expect((await pairWith({ ACCESS_ALLOWED_EMAIL: "someone-else@example.com" })).status).toBe(403);
  });

  it("lets the allowed identity through", async () => {
    expect((await pairWith({ ACCESS_ALLOWED_EMAIL: "owner@example.com" })).status).toBe(302);
  });

  it("is optional: unset means any verified identity", async () => {
    expect((await pairWith({})).status).toBe(302);
  });
});

describe("ACCESS_TEAM_DOMAIN shape", () => {
  const bad = [
    "evil.example.com",
    "team.cloudflareaccess.com.evil.com",
    "team.cloudflareaccess.com:8443",
    "a/b.cloudflareaccess.com",
    "TEAM.cloudflareaccess.com",
    "cloudflareaccess.com",
    ".cloudflareaccess.com",
    "team_x.cloudflareaccess.com",
    "a.b.cloudflareaccess.com",
  ];
  for (const domain of bad) {
    it(`refuses everything and fetches nothing for ${domain}`, async () => {
      const keys = await withKeys("k1");
      const fetch = vi.fn(async (_url: string, _init?: Init) => keys.jwks(["k1"]));
      const verify = createAccessVerifier({ fetch, now: () => NOW_MS });
      const token = await keys.token("k1", { ...longLived, iss: `https://${domain}` });
      expect(
        await verify(token, { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: AUD } as never),
      ).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });
  }

  it("accepts a plain team domain, with or without https://", async () => {
    const keys = await withKeys("k1");
    const verify = createAccessVerifier({
      fetch: async () => keys.jwks(["k1"]),
      now: () => NOW_MS,
    });
    const token = await keys.token("k1");
    expect(await verify(token, ENV)).not.toBeNull();
    expect(
      await verify(token, { ACCESS_TEAM_DOMAIN: `https://${DOMAIN}`, ACCESS_AUD: AUD } as never),
    ).not.toBeNull();
  });
});

describe("a failed key fetch", () => {
  it("is cached negatively for a short while, then tried again", async () => {
    const keys = await withKeys("k1");
    const time = clock();
    let healthy = false;
    const fetch = vi.fn(async (_url: string, _init?: Init) =>
      healthy ? keys.jwks(["k1"]) : new Response("down", { status: 503 }),
    );
    const verify = createAccessVerifier({ fetch, now: time.now });
    const token = await keys.token("k1");
    expect(await verify(token, ENV)).toBeNull();
    expect(await verify(token, ENV)).toBeNull();
    time.advance(1000);
    expect(await verify(token, ENV)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    healthy = true;
    time.advance(15 * MINUTE);
    expect(await verify(token, ENV)).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("also covers a fetch that throws, and the verifier answers null rather than throwing", async () => {
    const keys = await withKeys("k1");
    const fetch = vi.fn(async (_url: string, _init?: Init): Promise<Response> => {
      throw new Error("network down");
    });
    const verify = createAccessVerifier({ fetch, now: () => NOW_MS });
    const token = await keys.token("k1");
    expect(await verify(token, ENV)).toBeNull();
    expect(await verify(token, ENV)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("key fetches", () => {
  it("carry a timeout signal that has not fired", async () => {
    const keys = await withKeys("k1");
    const fetch = vi.fn(async (_url: string, _init?: Init) => keys.jwks(["k1"]));
    const verify = createAccessVerifier({ fetch, now: () => NOW_MS });
    await verify(await keys.token("k1"), ENV);
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });
});

describe("key cache clock rules", () => {
  it("keeps keys for an hour, then fetches again", async () => {
    const keys = await withKeys("k1");
    const time = clock();
    const fetch = vi.fn(async (_url: string, _init?: Init) => keys.jwks(["k1"]));
    const verify = createAccessVerifier({ fetch, now: time.now });
    const token = await keys.token("k1");
    expect(await verify(token, ENV)).not.toBeNull();
    time.advance(59 * MINUTE);
    expect(await verify(token, ENV)).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    time.advance(2 * MINUTE);
    expect(await verify(token, ENV)).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refetches for an unknown kid at most once a minute", async () => {
    const keys = await withKeys("k1", "k2");
    const time = clock();
    let published = ["k1"];
    const fetch = vi.fn(async (_url: string, _init?: Init) => keys.jwks(published));
    const verify = createAccessVerifier({ fetch, now: time.now });
    expect(await verify(await keys.token("k1"), ENV)).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    const unknown = await keys.token("k2");
    time.advance(10_000);
    expect(await verify(unknown, ENV)).toBeNull();
    expect(await verify(unknown, ENV)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    published = ["k1", "k2"];
    time.advance(51_000);
    expect(await verify(unknown, ENV)).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
