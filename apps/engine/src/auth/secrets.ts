import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A fresh 256-bit secret, base64url encoded (43 characters). */
export function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 of a secret, so stored or compared values have a fixed length. */
export function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time string comparison. Both sides are hashed first so neither the
 * content nor the length of the expected value leaks through timing.
 */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}
