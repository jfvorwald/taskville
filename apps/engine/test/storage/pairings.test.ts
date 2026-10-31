import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PairingStore } from "../../src/auth/pairing.ts";
import { openStorage } from "../../src/storage/index.ts";
import { useTempDir } from "./helpers.ts";

const dir = useTempDir();

describe("SqlitePairingRecords", () => {
  it("stores digests that survive reopening the database", () => {
    const path = join(dir(), "taskville.db");
    const first = openStorage(path);
    const records = first.pairingRecords();
    records.add("a".repeat(64));
    records.add("b".repeat(64));
    expect(records.list()).toEqual(["a".repeat(64), "b".repeat(64)]);
    first.close();

    const second = openStorage(path);
    try {
      expect(second.pairingRecords().list()).toEqual(["a".repeat(64), "b".repeat(64)]);
      expect(second.pairingRecords().clear()).toBe(2);
      expect(second.pairingRecords().list()).toEqual([]);
    } finally {
      second.close();
    }
  });

  it("backs a PairingStore, so a paired session is recognised after restart", () => {
    const path = join(dir(), "taskville.db");
    const first = openStorage(path);
    const pairing = new PairingStore({ records: first.pairingRecords() });
    const session = pairing.exchange(pairing.issueCode());
    first.close();
    expect(session).not.toBeNull();

    const second = openStorage(path);
    try {
      const restarted = new PairingStore({ records: second.pairingRecords() });
      expect(restarted.hasSession(session ?? "")).toBe(true);
      expect(restarted.hasSession("other")).toBe(false);
      expect(restarted.unpairAll()).toBe(1);
      expect(restarted.hasSession(session ?? "")).toBe(false);
    } finally {
      second.close();
    }
  });

  it("stores only the digest, never the session secret", () => {
    const path = join(dir(), "taskville.db");
    const storage = openStorage(path);
    try {
      const pairing = new PairingStore({ records: storage.pairingRecords() });
      const session = pairing.exchange(pairing.issueCode()) ?? "";
      expect(storage.pairingRecords().list()).not.toContain(session);
      expect(storage.pairingRecords().list()[0]).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      storage.close();
    }
  });
});
