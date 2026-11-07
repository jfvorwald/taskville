// The real Access verifier: a locally generated RS256 key, a stubbed JWKS, no network.

import { describe, expect, it, vi } from "vitest";
import { createAccessVerifier } from "../src/access.ts";

const DOMAIN = "team.cloudflareaccess.com";
const AUD = "aud-tag-1234";
const NOW_MS = Date.parse("2026-11-06T12:00:00Z");
const NOW = NOW_MS / 1000;
const ENV = { ACCESS_TEAM_DOMAIN: DOMAIN, ACCESS_AUD: AUD } as never;

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  return Buffer.from(raw).toString("base64url");
}

async function keyPair() {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

async function sign(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: "k1", typ: "JWT" },
): Promise<string> {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    encoder.encode(input),
  );
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

const good = {
  iss: `https://${DOMAIN}`,
  aud: [AUD],
  email: "owner@example.com",
  exp: NOW + 3600,
  iat: NOW - 60,
};

async function setup() {
  const pair = await keyPair();
  const other = await keyPair();
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "k1",
    alg: "RS256",
  };
  const fetch = vi.fn(async (_url: string) => Response.json({ keys: [jwk] }));
  const verify = createAccessVerifier({ fetch, now: () => NOW_MS });
  return { pair, other, fetch, verify };
}

describe("createAccessVerifier", () => {
  it("accepts a good token and returns the identity", async () => {
    const { pair, verify, fetch } = await setup();
    const result = await verify(await sign(pair.privateKey, good), ENV);
    expect(result).toEqual(expect.objectContaining({ email: "owner@example.com" }));
    expect(fetch).toHaveBeenCalledWith(`https://${DOMAIN}/cdn-cgi/access/certs`);
  });

  it("accepts a string audience and a past nbf", async () => {
    const { pair, verify } = await setup();
    const token = await sign(pair.privateKey, { ...good, aud: AUD, nbf: NOW - 5 });
    expect(await verify(token, ENV)).not.toBeNull();
  });

  const refused: [string, (ctx: Awaited<ReturnType<typeof setup>>) => Promise<string>][] = [
    ["signed by a different key", (c) => sign(c.other.privateKey, good)],
    ["the wrong audience", (c) => sign(c.pair.privateKey, { ...good, aud: ["other-aud"] })],
    [
      "the wrong issuer",
      (c) => sign(c.pair.privateKey, { ...good, iss: "https://evil.cloudflareaccess.com" }),
    ],
    ["expired", (c) => sign(c.pair.privateKey, { ...good, exp: NOW - 1 })],
    ["not yet valid (nbf)", (c) => sign(c.pair.privateKey, { ...good, nbf: NOW + 600 })],
    [
      "alg none",
      async () =>
        `${b64url(JSON.stringify({ alg: "none", kid: "k1" }))}.${b64url(JSON.stringify(good))}.`,
    ],
    [
      "alg none with a signature part",
      async () =>
        `${b64url(JSON.stringify({ alg: "none", kid: "k1" }))}.${b64url(JSON.stringify(good))}.AAAA`,
    ],
    ["alg HS256", (c) => sign(c.pair.privateKey, good, { alg: "HS256", kid: "k1" })],
    ["an unknown key id", (c) => sign(c.pair.privateKey, good, { alg: "RS256", kid: "nope" })],
    ["garbage", async () => "not.a.jwt"],
  ];

  for (const [name, make] of refused) {
    it(`refuses a token ${name}`, async () => {
      const ctx = await setup();
      expect(await ctx.verify(await make(ctx), ENV)).toBeNull();
    });
  }

  it("refuses everything when the team domain or audience is not configured", async () => {
    const { pair, verify, fetch } = await setup();
    const token = await sign(pair.privateKey, good);
    expect(await verify(token, { ACCESS_AUD: AUD } as never)).toBeNull();
    expect(await verify(token, { ACCESS_TEAM_DOMAIN: DOMAIN } as never)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches the keys once and caches them across calls", async () => {
    const { pair, verify, fetch } = await setup();
    const token = await sign(pair.privateKey, good);
    for (let i = 0; i < 5; i++) expect(await verify(token, ENV)).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
