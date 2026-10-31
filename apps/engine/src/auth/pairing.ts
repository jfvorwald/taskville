import { timingSafeEqual } from "node:crypto";
import { digest, generateSecret, safeEqual } from "./secrets.ts";

/**
 * Where paired sessions live: SHA-256 hex digests of session secrets, never
 * the secrets. The storage module backs this with the `pairings` table so a
 * pairing survives engine restarts (spec 001 data-model); tests and a
 * storage-less engine use `MemoryPairingRecords`.
 */
export interface PairingRecords {
  list(): readonly string[];
  add(secretHash: string): void;
  /** Removes every record and returns how many there were. */
  clear(): number;
}

export class MemoryPairingRecords implements PairingRecords {
  #hashes: string[] = [];

  list(): readonly string[] {
    return [...this.#hashes];
  }

  add(secretHash: string): void {
    this.#hashes.push(secretHash);
  }

  clear(): number {
    const count = this.#hashes.length;
    this.#hashes = [];
    return count;
  }
}

export interface PairingOptions {
  records?: PairingRecords;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Browser pairing. A pairing code is issued in-process by `taskville serve`
 * (never over HTTP, so a token holder cannot mint one), shown once in a URL
 * fragment, and exchanged exactly once for a session secret. The code lives in
 * memory only and stays valid until used, replaced, or the engine stops.
 */
export class PairingStore {
  readonly #records: PairingRecords;
  #pendingCode: string | null = null;

  constructor(options: PairingOptions = {}) {
    this.#records = options.records ?? new MemoryPairingRecords();
  }

  /** Issues a new single-use code. Any earlier unused code stops working. */
  issueCode(): string {
    this.#pendingCode = generateSecret();
    return this.#pendingCode;
  }

  /** Exchanges a valid code for a new session secret, or returns null. */
  exchange(code: string): string | null {
    const pending = this.#pendingCode;
    if (pending === null || !safeEqual(code, pending)) return null;
    this.#pendingCode = null;
    const session = generateSecret();
    this.#records.add(digest(session).toString("hex"));
    return session;
  }

  /** Whether `secret` belongs to a paired session. Compares every record in constant time. */
  hasSession(secret: string): boolean {
    const candidate = digest(secret);
    let found = false;
    for (const stored of this.#records.list()) {
      if (!SHA256_HEX.test(stored)) continue;
      if (timingSafeEqual(Buffer.from(stored, "hex"), candidate)) found = true;
    }
    return found;
  }

  /** Revokes every paired session and any outstanding code. Returns the number of sessions revoked. */
  unpairAll(): number {
    this.#pendingCode = null;
    return this.#records.clear();
  }
}
