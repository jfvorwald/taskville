import { describe, expect, it } from "vitest";
import { readPairingCode } from "../../src/pairing/fragment.ts";
import { establishSession, type PairingEnv, SESSION_KEY } from "../../src/pairing/pair.ts";

// M7.19 (#400). Fragment contract: the engine's link is `#pair=<code>` and, when the engine
// listens for the p key, `#pair=<code>&keys=1`. The web reads `keys` so the refused-link screen
// can say whether pressing p applies, and it clears the fragment after any attempt.
const CODE = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo";

function env(hash: string, fetchImpl: typeof fetch, storage?: Partial<Storage>) {
  const urls: string[] = [];
  const location = { hash, pathname: "/", search: "" };
  const e: PairingEnv = {
    location,
    history: {
      replaceState: (_d, _u, url) => {
        urls.push(String(url));
        location.hash = "";
      },
    },
    storage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      ...storage,
    },
    fetch: fetchImpl,
  };
  return { e, urls, location };
}

const answer = (status: number, body: unknown = {}) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;

describe("readPairingCode reads the keys flag", () => {
  it("reports keys=1 and leaves the code intact", () => {
    expect(readPairingCode(`#pair=${CODE}&keys=1`)).toEqual({
      present: true,
      code: CODE,
      keyListener: true,
    });
  });
  it("reports no key listener without the flag", () => {
    expect(readPairingCode(`#pair=${CODE}`)).toEqual({
      present: true,
      code: CODE,
      keyListener: false,
    });
  });
});

describe("the fragment is removed after every attempt (M7.19)", () => {
  const cases: Array<[string, typeof fetch, Partial<Storage> | undefined]> = [
    ["success", answer(200, { session: "s3cret" }), undefined],
    ["a refused code", answer(401), undefined],
    ["a server error", answer(500), undefined],
    [
      "a network failure",
      (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch,
      undefined,
    ],
    [
      "blocked storage",
      answer(200, { session: "s3cret" }),
      {
        setItem: () => {
          throw new Error("blocked");
        },
      },
    ],
  ];
  for (const [name, fetchImpl, storage] of cases) {
    it(`clears #pair= after ${name}`, async () => {
      const { e, urls, location } = env(`#pair=${CODE}&keys=1`, fetchImpl, storage);
      await establishSession(e);
      expect(urls).toEqual(["/"]);
      expect(location.hash).toBe("");
    });
  }

  it("clears an unusable fragment and a fragment next to a stored session", async () => {
    const bad = env("#pair=bad!code&keys=1", answer(200));
    await establishSession(bad.e);
    expect(bad.urls).toEqual(["/"]);
    const stored = env(`#pair=${CODE}`, answer(401), {
      getItem: (k: string) => (k === SESSION_KEY ? "old" : null),
    });
    await establishSession(stored.e);
    expect(stored.urls).toEqual(["/"]);
  });
});

describe("a refused link carries the key-listener flag into the state", () => {
  it("keeps keyListener true from a keys=1 link on a refused code", async () => {
    const { e } = env(`#pair=${CODE}&keys=1`, answer(401));
    expect(await establishSession(e)).toEqual({
      status: "failed",
      reason: "invalid_code",
      keyListener: true,
    });
  });
  it("keeps keyListener false from a plain link", async () => {
    const { e } = env(`#pair=${CODE}`, answer(401));
    expect(await establishSession(e)).toEqual({
      status: "failed",
      reason: "invalid_code",
      keyListener: false,
    });
  });
});
