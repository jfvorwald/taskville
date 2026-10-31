/** What the address bar's fragment says about pairing. */
export type PairingFragment =
  | { present: false }
  /** `code` is null when the fragment names a code that is not a plausible one. */
  | { present: true; code: string | null };

// Engine codes are 43 base64url characters; the exchange route accepts up to 256.
const CODE_SHAPE = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Reads the one-time pairing code from a URL fragment (`#pair=<code>`). Only the fragment is
 * ever read: browsers do not send it in requests or logs, which is why the engine's link puts
 * the code there (ARCHITECTURE.md section 13). A query string is never consulted.
 */
export function readPairingCode(hash: string): PairingFragment {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const value = params.get("pair");
  if (value === null) return { present: false };
  return { present: true, code: CODE_SHAPE.test(value) ? value : null };
}
