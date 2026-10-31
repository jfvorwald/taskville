import { useEffect } from "react";
import { useStore } from "zustand";
import { useSession } from "../pairing/session.tsx";
import { type DataState, type DataStore, dataStore } from "./store.ts";
import { startSync } from "./sync.ts";

/** How often attention is recomputed so "silent" trouble appears without an event. */
const ATTENTION_REFRESH_MS = 15_000;

/** Reads from the app-wide data store. Select narrowly: `useData((s) => s.counts)`. */
export function useData<T>(selector: (state: DataState) => T, store: DataStore = dataStore): T {
  return useStore(store, selector);
}

/**
 * Runs the sync loop for `projectId` while mounted. Mount once, under a paired app (it reads the
 * session from `useSession`). The wiring is the lead's: `<DataSync projectId=... />` in App.
 */
export function useDataSync(projectId: string, store: DataStore = dataStore): void {
  const secret = useSession();
  useEffect(() => {
    const sync = startSync({ store, projectId, secret });
    const timer = setInterval(() => store.getState().refreshAttention(), ATTENTION_REFRESH_MS);
    return () => {
      clearInterval(timer);
      void sync.stop();
    };
  }, [store, projectId, secret]);
}
