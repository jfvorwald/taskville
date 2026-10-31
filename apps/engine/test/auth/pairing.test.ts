import { describe, expect, it } from "vitest";
import { MemoryPairingRecords, PairingStore } from "../../src/auth/pairing.ts";

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

  it("keeps sessions in its records, so a store over the same records accepts them", () => {
    const records = new MemoryPairingRecords();
    const first = new PairingStore({ records });
    const session = first.exchange(first.issueCode()) ?? "";
    // A restarted engine builds a new store over the same persisted records.
    const restarted = new PairingStore({ records });
    expect(restarted.hasSession(session)).toBe(true);
    expect(records.list()).toHaveLength(1);
    expect(records.list()[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(records.list()[0]).not.toContain(session);
  });

  it("unpairAll clears the records", () => {
    const records = new MemoryPairingRecords();
    const store = new PairingStore({ records });
    store.exchange(store.issueCode());
    store.unpairAll();
    expect(records.list()).toEqual([]);
    expect(new PairingStore({ records }).unpairAll()).toBe(0);
  });

  it("ignores a malformed stored hash instead of throwing", () => {
    const records = new MemoryPairingRecords();
    records.add("not-hex");
    const store = new PairingStore({ records });
    expect(store.hasSession("anything")).toBe(false);
  });
});
