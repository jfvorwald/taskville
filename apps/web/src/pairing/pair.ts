import { readPairingCode } from "./fragment.ts";

/** localStorage key for the session secret. localStorage is per origin, so it is scoped by port. */
export const SESSION_KEY = "taskville.session";
/** Header every request after pairing carries. No cookies are used (ARCHITECTURE.md section 13). */
export const SESSION_HEADER = "X-Taskville-Session";

export type PairingState =
  | { status: "paired"; secret: string }
  /** No pairing code and no (still valid) stored session: the page may not ask for data. */
  | { status: "unpaired" }
  | { status: "failed"; reason: "invalid_code" | "network" | "storage" };

/** The browser pieces pairing needs, injectable so the logic runs without a browser. */
export interface PairingEnv {
  location: { hash: string; pathname: string; search: string };
  history: { replaceState(data: unknown, unused: string, url?: string | URL | null): void };
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  fetch: typeof fetch;
}

/** Establishes the page's session: a fresh pairing from the fragment, else a stored session. */
export async function establishSession(env: PairingEnv): Promise<PairingState> {
  const fragment = readPairingCode(env.location.hash);
  if (fragment.present) {
    // Clear first, so the code is gone from the address bar and history whatever happens next.
    env.history.replaceState(null, "", env.location.pathname + env.location.search);
    if (fragment.code === null) return { status: "failed", reason: "invalid_code" };
    return exchange(env, fragment.code);
  }
  return resumeStored(env);
}

async function exchange(env: PairingEnv, code: string): Promise<PairingState> {
  let response: Response;
  try {
    response = await env.fetch("/v1/pairing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch {
    return { status: "failed", reason: "network" };
  }
  if (response.status === 401) return { status: "failed", reason: "invalid_code" };
  if (!response.ok) return { status: "failed", reason: "network" };
  const body: unknown = await response.json().catch(() => undefined);
  const secret =
    typeof body === "object" && body !== null && "session" in body ? body.session : undefined;
  if (typeof secret !== "string" || secret === "") return { status: "failed", reason: "network" };
  try {
    env.storage.setItem(SESSION_KEY, secret);
  } catch {
    return { status: "failed", reason: "storage" };
  }
  return { status: "paired", secret };
}

async function resumeStored(env: PairingEnv): Promise<PairingState> {
  let secret: string | null;
  try {
    secret = env.storage.getItem(SESSION_KEY);
  } catch {
    return { status: "unpaired" };
  }
  if (secret === null || secret === "") return { status: "unpaired" };
  let response: Response;
  try {
    response = await env.fetch("/health", { headers: { [SESSION_HEADER]: secret } });
  } catch {
    return { status: "failed", reason: "network" };
  }
  if (response.status === 401) {
    // The engine does not know this session (revoked by `taskville unpair`, or a new home).
    try {
      env.storage.removeItem(SESSION_KEY);
    } catch {
      // Nothing more to do; the page is unpaired either way.
    }
    return { status: "unpaired" };
  }
  if (!response.ok) return { status: "failed", reason: "network" };
  return { status: "paired", secret };
}
