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

/** Upper bound for `maxPendingCodes`. */
export const MAX_PENDING_CODES_LIMIT = 16;

export interface PairingOptions {
  records?: PairingRecords;
  /**
   * How many unexpired, unused codes may be outstanding at once (M2.12). Default 1: a new code
   * replaces the previous one. Above 1, earlier codes keep working until used or expired, and
   * issuing past the cap drops the oldest. From 1 to 16.
   */
  maxPendingCodes?: number;
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
 * fragment, and exchanged exactly once for a session secret. Codes live in
 * memory only and stay valid until used, replaced (past `maxPendingCodes`),
 * expired (PAIRING_CODE_TTL_MS after issue), or the engine stops.
 */
export class PairingStore {
  readonly #records: PairingRecords;
  readonly #revokeListeners = new Set<() => void>();
  readonly #now: () => number;
  readonly #maxPending: number;
  /** Outstanding codes, oldest first. */
  #pending: { code: string; issuedAt: number }[] = [];

  constructor(options: PairingOptions = {}) {
    const maxPending = options.maxPendingCodes ?? 1;
    if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > MAX_PENDING_CODES_LIMIT) {
      throw new RangeError(
        `maxPendingCodes must be a whole number from 1 to ${MAX_PENDING_CODES_LIMIT}`,
      );
    }
    this.#records = options.records ?? new MemoryPairingRecords();
    this.#now = options.now ?? (() => performance.now());
    this.#maxPending = maxPending;
  }

  /**
   * Issues a new single-use code. With the default cap of one, any earlier unused code stops
   * working; with a larger cap, the oldest is dropped only once the cap is reached.
   */
  issueCode(): string {
    this.#dropExpired();
    const code = generateSecret();
    this.#pending.push({ code, issuedAt: this.#now() });
    while (this.#pending.length > this.#maxPending) this.#pending.shift();
    return code;
  }

  /** Exchanges a valid, unexpired code for a new session secret, or returns null. */
  exchange(code: string): string | null {
    this.#dropExpired();
    // Compare against every outstanding code, so the time taken does not say which one matched.
    let match = -1;
    for (const [index, pending] of this.#pending.entries()) {
      if (safeEqual(code, pending.code)) match = index;
    }
    if (match < 0) return null;
    this.#pending.splice(match, 1);
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

  /** Revokes every paired session and every outstanding code. Returns the number of sessions revoked. */
  unpairAll(): number {
    this.#pending = [];
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

  /** Expired codes are gone for good, even if the clock later goes back. */
  #dropExpired(): void {
    const now = this.#now();
    this.#pending = this.#pending.filter((p) => now - p.issuedAt < PAIRING_CODE_TTL_MS);
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
