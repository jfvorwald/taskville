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

/**
 * How long a pairing code stays valid after it is issued (M1.18 F4): a link
 * printed to a log and never opened stops working instead of lasting until the
 * engine stops. `taskville serve` prints this window next to the link.
 */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

export interface PairingOptions {
  records?: PairingRecords;
  /**
   * Monotonic clock in milliseconds for code expiry. Defaults to
   * `performance.now()`, so a wall-clock change cannot extend a code's life.
   */
  now?: () => number;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Browser pairing. A pairing code is issued in-process by `taskville serve`
 * (never over HTTP, so a token holder cannot mint one), shown once in a URL
 * fragment, and exchanged exactly once for a session secret. The code lives in
 * memory only and stays valid until used, replaced, expired (PAIRING_CODE_TTL_MS
 * after issue), or the engine stops.
 */
export class PairingStore {
  readonly #records: PairingRecords;
  readonly #revokeListeners = new Set<() => void>();
  readonly #now: () => number;
  #pendingCode: string | null = null;
  #issuedAt = 0;

  constructor(options: PairingOptions = {}) {
    this.#records = options.records ?? new MemoryPairingRecords();
    this.#now = options.now ?? (() => performance.now());
  }

  /** Issues a new single-use code. Any earlier unused code stops working. */
  issueCode(): string {
    this.#pendingCode = generateSecret();
    this.#issuedAt = this.#now();
    return this.#pendingCode;
  }

  /** Exchanges a valid, unexpired code for a new session secret, or returns null. */
  exchange(code: string): string | null {
    if (this.#pendingCode !== null && this.#now() - this.#issuedAt >= PAIRING_CODE_TTL_MS) {
      this.#pendingCode = null; // expired: gone for good, even if the clock goes back
    }
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
    const revoked = this.#records.clear();
    for (const listener of [...this.#revokeListeners]) {
      try {
        listener();
      } catch {
        // One failing listener must not stop the others or the revoke.
      }
    }
    return revoked;
  }

  /**
   * Calls `listener` after every `unpairAll`, so connections authenticated by a
   * session (open SSE streams) can end at once. Returns an unsubscribe function.
   */
  onRevoke(listener: () => void): () => void {
    this.#revokeListeners.add(listener);
    return () => {
      this.#revokeListeners.delete(listener);
    };
  }
}
