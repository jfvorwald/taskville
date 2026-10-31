import { describe, expect, it } from "vitest";
import { readPairingCode } from "../../src/pairing/fragment.ts";
import {
  establishSession,
  type PairingEnv,
  SESSION_HEADER,
  SESSION_KEY,
} from "../../src/pairing/pair.ts";

const CODE = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo";

class MemoryStorage {
  items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

interface Harness {
  env: PairingEnv;
  storage: MemoryStorage;
  urls: string[];
  requests: { url: string; init: RequestInit | undefined }[];
}

function harness(
  start: { hash?: string; search?: string },
  respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): Harness {
  const storage = new MemoryStorage();
  const urls: string[] = [];
  const requests: Harness["requests"] = [];
  const location = { hash: start.hash ?? "", search: start.search ?? "", pathname: "/" };
  const env: PairingEnv = {
    location,
    history: {
      replaceState: (_data, _unused, url) => {
        urls.push(String(url));
        const hashAt = String(url).indexOf("#");
        location.hash = hashAt < 0 ? "" : String(url).slice(hashAt);
      },
    },
    storage,
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return respond(String(input), init);
    },
  };
  return { env, storage, urls, requests };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("readPairingCode", () => {
  it("reads the code from the URL fragment", () => {
    expect(readPairingCode(`#pair=${CODE}`)).toEqual({ present: true, code: CODE });
  });

  it("never reads the query string or a lookalike key", () => {
    expect(readPairingCode("")).toEqual({ present: false });
    expect(readPairingCode("#")).toEqual({ present: false });
    expect(readPairingCode(`#paired=${CODE}`)).toEqual({ present: false });
    expect(readPairingCode(`#/route?pair=${CODE}`)).toEqual({ present: false });
  });

  it("flags a present but malformed code without returning it", () => {
    expect(readPairingCode("#pair=")).toEqual({ present: true, code: null });
    expect(readPairingCode("#pair=a b")).toEqual({ present: true, code: null });
    expect(readPairingCode(`#pair=${"a".repeat(257)}`)).toEqual({ present: true, code: null });
    expect(readPairingCode("#pair=%3Cscript%3E")).toEqual({ present: true, code: null });
  });
});

describe("establishSession: pairing from the fragment", () => {
  it("exchanges the code, stores the secret, and clears the fragment before the request", async () => {
    let hashAtRequest: string | undefined;
    const h = harness({ hash: `#pair=${CODE}`, search: "?x=1" }, () => {
      hashAtRequest = h.env.location.hash;
      return json(200, { session: "secret-1" });
    });
    const state = await establishSession(h.env);
    expect(state).toEqual({ status: "paired", secret: "secret-1" });
    expect(h.storage.getItem(SESSION_KEY)).toBe("secret-1");
    expect(hashAtRequest).toBe("");
    expect(h.urls).toEqual(["/?x=1"]);
    const [req] = h.requests;
    expect(req?.url).toBe("/v1/pairing");
    expect(req?.init?.method).toBe("POST");
    expect(JSON.parse(String(req?.init?.body))).toEqual({ code: CODE });
    // The code travels in the body only, never in the URL or a header.
    expect(req?.url).not.toContain(CODE);
    expect(JSON.stringify(req?.init?.headers ?? {})).not.toContain(CODE);
  });

  it("clears the fragment and reports invalid_code when the engine refuses the code", async () => {
    const h = harness({ hash: `#pair=${CODE}` }, () =>
      json(401, { error: { code: "invalid_pairing_code" } }),
    );
    const state = await establishSession(h.env);
    expect(state).toEqual({ status: "failed", reason: "invalid_code" });
    expect(h.storage.getItem(SESSION_KEY)).toBeNull();
    expect(h.env.location.hash).toBe("");
  });

  it("clears a malformed fragment without calling the engine", async () => {
    const h = harness({ hash: "#pair=a b" }, () => json(200, { session: "x" }));
    const state = await establishSession(h.env);
    expect(state).toEqual({ status: "failed", reason: "invalid_code" });
    expect(h.requests).toEqual([]);
    expect(h.env.location.hash).toBe("");
  });

  it("reports pairing_network when the exchange cannot finish, since the code is gone from the page", async () => {
    const down = harness({ hash: `#pair=${CODE}` }, () => {
      throw new TypeError("fetch failed");
    });
    expect(await establishSession(down.env)).toEqual({
      status: "failed",
      reason: "pairing_network",
    });
    const odd = harness({ hash: `#pair=${CODE}` }, () => json(200, { session: 7 }));
    expect(await establishSession(odd.env)).toEqual({
      status: "failed",
      reason: "pairing_network",
    });
    expect(odd.storage.getItem(SESSION_KEY)).toBeNull();
  });

  it("does not use a bad new code to wipe an existing good session", async () => {
    const h = harness({ hash: `#pair=${CODE}` }, () => json(401, {}));
    h.storage.setItem(SESSION_KEY, "old-secret");
    await establishSession(h.env);
    expect(h.storage.getItem(SESSION_KEY)).toBe("old-secret");
  });

  it("reports storage when the secret cannot be kept", async () => {
    const h = harness({ hash: `#pair=${CODE}` }, () => json(200, { session: "s" }));
    h.env.storage.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    expect(await establishSession(h.env)).toEqual({ status: "failed", reason: "storage" });
  });
});

describe("establishSession: a stored session", () => {
  it("verifies it with the session header and is paired when the engine accepts it", async () => {
    const h = harness({}, () => json(200, { status: "ok" }));
    h.storage.setItem(SESSION_KEY, "old-secret");
    expect(await establishSession(h.env)).toEqual({ status: "paired", secret: "old-secret" });
    const [req] = h.requests;
    expect(req?.url).toBe("/health");
    expect((req?.init?.headers as Record<string, string> | undefined)?.[SESSION_HEADER]).toBe(
      "old-secret",
    );
  });

  it("forgets a session the engine no longer knows and shows unpaired", async () => {
    const h = harness({}, () => json(401, {}));
    h.storage.setItem(SESSION_KEY, "revoked");
    expect(await establishSession(h.env)).toEqual({ status: "unpaired" });
    expect(h.storage.getItem(SESSION_KEY)).toBeNull();
  });

  it("keeps the session when the engine is merely unreachable", async () => {
    const h = harness({}, () => {
      throw new TypeError("fetch failed");
    });
    h.storage.setItem(SESSION_KEY, "kept");
    expect(await establishSession(h.env)).toEqual({ status: "failed", reason: "network" });
    expect(h.storage.getItem(SESSION_KEY)).toBe("kept");
  });

  it("is unpaired, and asks the engine for nothing, with no code and no session", async () => {
    const h = harness({}, () => json(200, {}));
    expect(await establishSession(h.env)).toEqual({ status: "unpaired" });
    expect(h.requests).toEqual([]);
  });

  it("treats unreadable storage as unpaired", async () => {
    const h = harness({}, () => json(200, {}));
    h.env.storage.getItem = () => {
      throw new DOMException("denied", "SecurityError");
    };
    expect(await establishSession(h.env)).toEqual({ status: "unpaired" });
  });
});
