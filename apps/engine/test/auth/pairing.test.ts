import { describe, expect, it } from "vitest";
import { PairingStore } from "../../src/auth/pairing.ts";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("PairingStore", () => {
  it("exchanges a fresh code for a session secret that is not the code", () => {
    const store = new PairingStore();
    const code = store.issueCode();
    const session = store.exchange(code);
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session).not.toBe(code);
    expect(store.hasSession(session ?? "")).toBe(true);
  });

  it("accepts a code only once", () => {
    const store = new PairingStore();
    const code = store.issueCode();
    expect(store.exchange(code)).not.toBeNull();
    expect(store.exchange(code)).toBeNull();
  });

  it("rejects a code it never issued", () => {
    const store = new PairingStore();
    store.issueCode();
    expect(store.exchange("not-a-real-code")).toBeNull();
    expect(store.exchange("")).toBeNull();
  });

  it("rejects an expired code", () => {
    const c = clock();
    const store = new PairingStore({ now: c.now, codeTtlMs: 60_000 });
    const code = store.issueCode();
    c.advance(60_001);
    expect(store.exchange(code)).toBeNull();
  });

  it("invalidates the previous code when a new one is issued", () => {
    const store = new PairingStore();
    const first = store.issueCode();
    const second = store.issueCode();
    expect(store.exchange(first)).toBeNull();
    expect(store.exchange(second)).not.toBeNull();
  });

  it("keeps several paired sessions at once", () => {
    const store = new PairingStore();
    const a = store.exchange(store.issueCode()) ?? "";
    const b = store.exchange(store.issueCode()) ?? "";
    expect(store.hasSession(a)).toBe(true);
    expect(store.hasSession(b)).toBe(true);
    expect(store.hasSession("guess")).toBe(false);
    expect(store.hasSession("")).toBe(false);
  });

  it("unpairAll revokes every session and the outstanding code", () => {
    const store = new PairingStore();
    const a = store.exchange(store.issueCode()) ?? "";
    const b = store.exchange(store.issueCode()) ?? "";
    const pending = store.issueCode();
    expect(store.unpairAll()).toBe(2);
    expect(store.hasSession(a)).toBe(false);
    expect(store.hasSession(b)).toBe(false);
    expect(store.exchange(pending)).toBeNull();
  });
});
