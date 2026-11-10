// Shared pieces for the Access verifier tests: a local RS256 key, a signer, and fixed claims.

export const DOMAIN = "team.cloudflareaccess.com";
export const AUD = "aud-tag-1234";
export const NOW_MS = Date.parse("2026-11-06T12:00:00Z");
export const NOW = NOW_MS / 1000;
export const ENV = { ACCESS_TEAM_DOMAIN: DOMAIN, ACCESS_AUD: AUD } as never;

const encoder = new TextEncoder();

export function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  return Buffer.from(raw).toString("base64url");
}

export async function keyPair() {
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

export type KeyPair = Awaited<ReturnType<typeof keyPair>>;

export async function sign(
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

export async function jwkOf(pair: KeyPair, kid: string) {
  return { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256" };
}

export const good = {
  iss: `https://${DOMAIN}`,
  aud: [AUD],
  email: "owner@example.com",
  exp: NOW + 3600,
  iat: NOW - 60,
};
