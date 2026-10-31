import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { browserEnv } from "./browser-env.ts";
import { establishSession, type PairingState } from "./pair.ts";

const SessionContext = createContext<string | null>(null);

export const SessionProvider = SessionContext.Provider;

/** The paired session secret, for the `X-Taskville-Session` header. Only valid under a paired app. */
export function useSession(): string {
  const secret = useContext(SessionContext);
  if (secret === null) throw new Error("useSession outside a paired app");
  return secret;
}

// One attempt per page load. React StrictMode runs effects twice in development, and a second
// run would find the fragment already cleared while the first exchange is still in flight.
let attempt: Promise<PairingState> | undefined;

export type PairingStatus = PairingState | { status: "checking" };

/** Establishes the session once on load; `retry` tries again (a stored session, or a fresh link). */
export function usePairing(): { state: PairingStatus; retry: () => void } {
  const [state, setState] = useState<PairingStatus>({ status: "checking" });

  useEffect(() => {
    let live = true;
    attempt ??= establishSession(browserEnv());
    void attempt.then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);

  const retry = useCallback(() => {
    setState({ status: "checking" });
    attempt = establishSession(browserEnv());
    void attempt.then(setState);
  }, []);

  return { state, retry };
}
