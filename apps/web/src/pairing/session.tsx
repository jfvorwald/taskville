import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Attempts } from "./attempts.ts";
import { browserEnv, watchPairingFragment } from "./browser-env.ts";
import { establishSession, type PairingState } from "./pair.ts";

const SessionContext = createContext<string | null>(null);

export const SessionProvider = SessionContext.Provider;

/** The paired session secret, for the `X-Taskville-Session` header. Only valid under a paired app. */
export function useSession(): string {
  const secret = useContext(SessionContext);
  if (secret === null) throw new Error("useSession outside a paired app");
  return secret;
}

const attempts = new Attempts();

export type PairingStatus = PairingState | { status: "checking" };

/** Establishes the session once on load; `retry` starts a new attempt (stored session or fresh link). */
export function usePairing(): { state: PairingStatus; retry: () => void } {
  const [state, setState] = useState<PairingStatus>({ status: "checking" });

  // One attempt per page load: StrictMode runs effects twice in development, and a second run
  // would find the fragment already cleared while the first exchange is still in flight.
  useEffect(() => {
    attempts.deliver(
      attempts.current(() => establishSession(browserEnv())),
      setState,
    );
  }, []);

  const retry = useCallback(() => {
    setState({ status: "checking" });
    attempts.deliver(
      attempts.start(() => establishSession(browserEnv())),
      setState,
    );
  }, []);

  // A new link pasted into this tab only changes the fragment; pair with it without a reload.
  useEffect(() => watchPairingFragment(window, retry), [retry]);

  return { state, retry };
}
