// The pairing store: one Durable Object holding single-use pairing codes and session secrets.
// A Durable Object is strongly consistent, so a code redeems exactly once whichever Worker
// instance handled the request. Codes and secrets are stored as SHA-256 digests. Reached only
// through `fetch`, by the Worker; the paths below are internal.

import type { DurableObjectStateLike } from "./env.ts";

/** A pairing code lives 10 minutes, as the engine's does. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
/** A session lives 30 days; after that the owner pairs again through `/pair`. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CODE_PREFIX = "code:";
const SESSION_PREFIX = "session:";

interface CodeRecord {
  identity: string;
  expiresAt: number;
}

interface SessionRecord {
  identity: string;
  createdAt: number;
}

function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

async function field(request: Request, name: string): Promise<string | undefined> {
  const body: unknown = await request.json().catch(() => undefined);
  const value = (body as Record<string, unknown> | null | undefined)?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class PairingStore {
  readonly #state: DurableObjectStateLike;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(state: DurableObjectStateLike, _env: unknown) {
    this.#state = state;
  }

  /** One request at a time: a read and the write that follows it never interleave. */
  fetch(request: Request): Promise<Response> {
    const run = () => this.#handle(request);
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return json({ error: "not_found" }, 404);
    if (path === "/mint") return this.#mint(request);
    if (path === "/redeem") return this.#redeem(request);
    if (path === "/check") return this.#check(request);
    if (path === "/revoke") return this.#revoke(request);
    return json({ error: "not_found" }, 404);
  }

  async #mint(request: Request): Promise<Response> {
    const identity = await field(request, "identity");
    if (identity === undefined) return json({ error: "bad_request" }, 400);
    const now = Date.now();
    const { storage } = this.#state;
    for (const [key, record] of await storage.list<CodeRecord>({ prefix: CODE_PREFIX })) {
      if (record.expiresAt <= now) await storage.delete(key);
    }
    const code = token();
    const record: CodeRecord = { identity, expiresAt: now + PAIRING_CODE_TTL_MS };
    await storage.put(`${CODE_PREFIX}${await digest(code)}`, record);
    return json({ code });
  }

  async #redeem(request: Request): Promise<Response> {
    const code = await field(request, "code");
    if (code === undefined) return json({ error: "invalid_code" }, 401);
    const { storage } = this.#state;
    const key = `${CODE_PREFIX}${await digest(code)}`;
    const record = await storage.get<CodeRecord>(key);
    if (record === undefined) return json({ error: "invalid_code" }, 401);
    // Used or not, an expired code is gone, and a good one is spent by this exchange.
    await storage.delete(key);
    const now = Date.now();
    if (record.expiresAt <= now) return json({ error: "invalid_code" }, 401);
    const session = token();
    const created: SessionRecord = { identity: record.identity, createdAt: now };
    await storage.put(`${SESSION_PREFIX}${await digest(session)}`, created);
    return json({ session });
  }

  async #check(request: Request): Promise<Response> {
    const session = await field(request, "session");
    if (session === undefined) return json({ valid: false }, 401);
    const { storage } = this.#state;
    const key = `${SESSION_PREFIX}${await digest(session)}`;
    const record = await storage.get<SessionRecord>(key);
    if (record === undefined) return json({ valid: false }, 401);
    if (record.createdAt + SESSION_TTL_MS <= Date.now()) {
      await storage.delete(key);
      return json({ valid: false }, 401);
    }
    return json({ valid: true });
  }

  /** Ends the one session it is given. */
  async #revoke(request: Request): Promise<Response> {
    const session = await field(request, "session");
    if (session === undefined) return json({ revoked: 0 });
    const removed = await this.#state.storage.delete(`${SESSION_PREFIX}${await digest(session)}`);
    return json({ revoked: removed ? 1 : 0 });
  }
}
