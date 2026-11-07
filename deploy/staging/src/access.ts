// Verifies the Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) against the team's signing keys.
// This is the one place the Worker makes an outbound call: the keys at
// `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. Anything missing or wrong fails
// closed (null), and claims are checked before any key is fetched.

import type { AccessIdentity, Env, VerifyAccess } from "./env.ts";

interface Jwk {
  kid?: string;
  kty?: string;
  [member: string]: unknown;
}

interface KeySet {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

/** Keys are kept for an hour, and re-read at most once a minute when a token names a new one. */
const KEY_TTL_MS = 60 * 60 * 1000;
const REFETCH_MIN_MS = 60 * 1000;

export interface AccessVerifierOptions {
  /** Where the keys come from; defaults to the global `fetch`. */
  fetch?: (url: string) => Promise<Response>;
  now?: () => number;
}

function decode(part: string): Uint8Array<ArrayBuffer> {
  const base64 = part.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function parseObject(part: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(decode(part)));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function teamDomain(raw: string | undefined): string | undefined {
  const domain = raw
    ?.trim()
    .replace(/^https:\/\//, "")
    .replace(/\/+$/, "");
  return domain === undefined || domain === "" ? undefined : domain;
}

export function createAccessVerifier(options: AccessVerifierOptions = {}): VerifyAccess {
  const getJson = options.fetch ?? ((url: string) => globalThis.fetch(url));
  const now = options.now ?? Date.now;
  const cache = new Map<string, KeySet>();

  async function load(domain: string): Promise<KeySet> {
    const response = await getJson(`https://${domain}/cdn-cgi/access/certs`);
    if (!response.ok) throw new Error(`Access keys answered ${response.status}`);
    const body = (await response.json()) as { keys?: Jwk[] };
    const keys = new Map<string, CryptoKey>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
      keys.set(
        jwk.kid,
        await crypto.subtle.importKey(
          "jwk",
          jwk as never, // a published RSA public key; no DOM lib here for the JsonWebKey type
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      );
    }
    const set = { keys, fetchedAt: now() };
    cache.set(domain, set);
    return set;
  }

  async function keyFor(domain: string, kid: string): Promise<CryptoKey | undefined> {
    let set = cache.get(domain);
    if (set !== undefined && now() - set.fetchedAt > KEY_TTL_MS) set = undefined;
    const known = set?.keys.get(kid);
    if (known !== undefined) return known;
    if (set !== undefined && now() - set.fetchedAt < REFETCH_MIN_MS) return undefined;
    return (await load(domain)).keys.get(kid);
  }

  return async (jwt: string, env: Env): Promise<AccessIdentity | null> => {
    const domain = teamDomain(env.ACCESS_TEAM_DOMAIN);
    const audience = env.ACCESS_AUD;
    if (domain === undefined || audience === undefined || audience === "") return null;
    const parts = jwt.split(".");
    const [headerPart, payloadPart, signaturePart] = parts;
    if (parts.length !== 3 || !headerPart || !payloadPart || !signaturePart) return null;
    const header = parseObject(headerPart);
    const payload = parseObject(payloadPart);
    if (header?.alg !== "RS256" || typeof header.kid !== "string" || payload === undefined) {
      return null;
    }

    const seconds = now() / 1000;
    const { iss, aud, exp, nbf, email } = payload;
    if (iss !== `https://${domain}`) return null;
    if (!(Array.isArray(aud) ? aud.includes(audience) : aud === audience)) return null;
    if (typeof exp !== "number" || exp <= seconds) return null;
    if (nbf !== undefined && (typeof nbf !== "number" || nbf > seconds)) return null;
    if (typeof email !== "string" || email === "") return null;

    const key = await keyFor(domain, header.kid);
    if (key === undefined) return null;
    const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decode(signaturePart),
      signed,
    );
    return valid ? { email } : null;
  };
}

/** What the deployed Worker uses. */
export const realAccessVerifier: VerifyAccess = createAccessVerifier();
