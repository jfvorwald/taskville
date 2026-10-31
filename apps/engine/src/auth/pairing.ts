import { timingSafeEqual } from "node:crypto";
import { digest, generateSecret, safeEqual } from "./secrets.ts";

export const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000;

export interface PairingOptions {
  /** Clock in milliseconds; injected for tests. */
  now?: () => number;
  /** How long an issued pairing code stays valid. */
  codeTtlMs?: number;
}

interface PendingCode {
  value: string;
  expiresAt: number;
}

/**
 * Browser pairing state, held in memory only. A pairing code is issued
 * in-process by `taskville serve` (never over HTTP, so a token holder cannot
 * mint one), shown once in a URL fragment, and exchanged exactly once for a
 * session secret. Only SHA-256 digests of session secrets are kept. Pairings
 * end when the engine stops or on `unpairAll`.
 */
export class PairingStore {
  readonly #now: () => number;
  readonly #ttlMs: number;
  #pending: PendingCode | null = null;
  #sessions: Buffer[] = [];

  constructor(options: PairingOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.codeTtlMs ?? DEFAULT_CODE_TTL_MS;
  }

  /** Issues a new single-use code. Any earlier unused code stops working. */
  issueCode(): string {
    const value = generateSecret();
    this.#pending = { value, expiresAt: this.#now() + this.#ttlMs };
    return value;
  }

  /** Exchanges a valid code for a new session secret, or returns null. */
  exchange(code: string): string | null {
    const pending = this.#pending;
    if (pending === null || this.#now() >= pending.expiresAt) return null;
    if (!safeEqual(code, pending.value)) return null;
    this.#pending = null;
    const session = generateSecret();
    this.#sessions.push(digest(session));
    return session;
  }

  /** Whether `secret` belongs to a paired session. Compares in constant time per session. */
  hasSession(secret: string): boolean {
    const candidate = digest(secret);
    let found = false;
    for (const stored of this.#sessions) {
      if (timingSafeEqual(stored, candidate)) found = true;
    }
    return found;
  }

  /** Revokes every paired session and any outstanding code. Returns the number of sessions revoked. */
  unpairAll(): number {
    const revoked = this.#sessions.length;
    this.#sessions = [];
    this.#pending = null;
    return revoked;
  }
}
