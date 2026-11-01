import { afterEach, describe, expect, it, vi } from "vitest";
import { browserEnv } from "../../src/pairing/browser-env.ts";
import { establishSession } from "../../src/pairing/pair.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubWindow(localStorage: () => Storage) {
  vi.stubGlobal("window", {
    location: { hash: "#pair=abc", pathname: "/", search: "" },
    history: { replaceState: () => {} },
    fetch: async () => new Response(JSON.stringify({ session: "s" }), { status: 200 }),
    get localStorage() {
      return localStorage();
    },
  });
}

describe("browserEnv", () => {
  it("builds even when the browser blocks site storage, and pairing reports it", async () => {
    stubWindow(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const env = browserEnv();
    expect(await establishSession(env)).toEqual({ status: "failed", reason: "storage" });
  });

  it("treats blocked storage as unpaired when there is no pairing code", async () => {
    stubWindow(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const env = browserEnv();
    env.location = { hash: "", pathname: "/", search: "" };
    expect(await establishSession(env)).toEqual({ status: "unpaired" });
  });
});
