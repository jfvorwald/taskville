import { describe, expect, it } from "vitest";
import { MemoryPairingRecords, PAIRING_CODE_TTL_MS, PairingStore } from "../../src/auth/pairing.ts";

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

  describe("code expiry (M1.18 F4)", () => {
    function clocked() {
      let ms = 1_000_000;
      const store = new PairingStore({ now: () => ms });
      return {
        store,
        advance(by: number) {
          ms += by;
        },
      };
    }

    it("is about ten minutes", () => {
      expect(PAIRING_CODE_TTL_MS).toBe(10 * 60 * 1000);
    });

    it("accepts a code just before it expires", () => {
      const { store, advance } = clocked();
      const code = store.issueCode();
      advance(PAIRING_CODE_TTL_MS - 1);
      expect(store.exchange(code)).not.toBeNull();
    });

    it("rejects a code once its time is up, and keeps rejecting it", () => {
      const { store, advance } = clocked();
      const code = store.issueCode();
      advance(PAIRING_CODE_TTL_MS);
      expect(store.exchange(code)).toBeNull();
      advance(-PAIRING_CODE_TTL_MS);
      expect(store.exchange(code)).toBeNull();
    });

    it("counts from the latest issue: a new code gets a full window", () => {
      const { store, advance } = clocked();
      store.issueCode();
      advance(PAIRING_CODE_TTL_MS - 1);
      const fresh = store.issueCode();
      advance(PAIRING_CODE_TTL_MS - 1);
      expect(store.exchange(fresh)).not.toBeNull();
    });

    it("does not affect sessions already paired", () => {
      const { store, advance } = clocked();
      const session = store.exchange(store.issueCode()) ?? "";
      advance(PAIRING_CODE_TTL_MS * 10);
      expect(store.hasSession(session)).toBe(true);
    });
  });

  describe("several outstanding codes (M2.12, maxPendingCodes)", () => {
    function clocked(maxPendingCodes: number) {
      let ms = 1_000_000;
      const store = new PairingStore({ now: () => ms, maxPendingCodes });
      return {
        store,
        advance(by: number) {
          ms += by;
        },
      };
    }

    it("keeps an earlier unexpired code working after a new one is issued", () => {
      const { store } = clocked(3);
      const first = store.issueCode();
      const second = store.issueCode();
      expect(store.exchange(first)).not.toBeNull();
      expect(store.exchange(second)).not.toBeNull();
    });

    it("accepts each code once", () => {
      const { store } = clocked(3);
      const first = store.issueCode();
      store.issueCode();
      expect(store.exchange(first)).not.toBeNull();
      expect(store.exchange(first)).toBeNull();
    });

    it("expires each code on its own clock, ten minutes after its issue", () => {
      const { store, advance } = clocked(3);
      const first = store.issueCode();
      advance(PAIRING_CODE_TTL_MS - 1000);
      const second = store.issueCode();
      advance(1000);
      expect(store.exchange(first)).toBeNull();
      advance(PAIRING_CODE_TTL_MS - 1001);
      expect(store.exchange(second)).not.toBeNull();
    });

    it("drops the oldest code beyond the cap, so a pasted stream cannot pile up codes", () => {
      const { store } = clocked(2);
      const first = store.issueCode();
      const second = store.issueCode();
      const third = store.issueCode();
      expect(store.exchange(first)).toBeNull();
      expect(store.exchange(second)).not.toBeNull();
      expect(store.exchange(third)).not.toBeNull();
    });

    it("unpairAll revokes every outstanding code", () => {
      const { store } = clocked(3);
      const first = store.issueCode();
      const second = store.issueCode();
      store.unpairAll();
      expect(store.exchange(first)).toBeNull();
      expect(store.exchange(second)).toBeNull();
    });

    it("refuses a cap that is not a whole number from 1 to 16", () => {
      for (const maxPendingCodes of [0, -1, 1.5, 17, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => new PairingStore({ maxPendingCodes })).toThrow(RangeError);
      }
    });

    it("defaults to one code, as before", () => {
      const store = new PairingStore();
      const first = store.issueCode();
      const second = store.issueCode();
      expect(store.exchange(first)).toBeNull();
      expect(store.exchange(second)).not.toBeNull();
    });
  });
});
