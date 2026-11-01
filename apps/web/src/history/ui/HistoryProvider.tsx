import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useCurrentProjectId } from "../../data/project.ts";
import { createDataStore, type DataStore, dataStore } from "../../data/store.ts";
import { SESSION_HEADER } from "../../pairing/pair.ts";
import { useSession } from "../../pairing/session.tsx";
import { themeController } from "../../themes/core/index.ts";
import { createHistoryStore, type HistoryStore } from "../state/store.ts";

interface Presentation {
  mode: "live" | "history";
  store: DataStore;
  time: number | null;
  range: { first: number; last: number } | null;
  pending: boolean;
  error: string | null;
  enter(): void;
  seek(time: number): void;
  exit(): void;
}

const live = { mode: "live" as const, store: dataStore, time: null, range: null };
const fallback: Presentation = {
  ...live,
  pending: false,
  error: null,
  enter() {},
  seek() {},
  exit() {},
};
const Context = createContext<Presentation | null>(null);

export function useHistoryPresentation(): Presentation {
  return useContext(Context) ?? fallback;
}

/** Owns replay resources in an effect, including StrictMode's setup/cleanup cycle. */
export function HistoryProvider({ children }: { children: ReactNode }) {
  const projectId = useCurrentProjectId();
  const secret = useSession();
  const [current, setCurrent] = useState<{
    projectId: string;
    secret: string;
    value: Presentation;
  } | null>(null);
  useEffect(() => {
    let active = true;
    let generation = 0;
    let metadata: AbortController | undefined;
    let controller: HistoryStore | undefined;
    let unsubscribeHistory: (() => void) | undefined;
    let replayTime = 0;
    const snapshot = createDataStore({ now: () => replayTime });
    snapshot.getState().reset(projectId);
    let value: Presentation;
    function publish(update: Partial<Presentation>) {
      if (!active) return;
      value = { ...value, ...update };
      setCurrent({ projectId, secret, value });
    }
    function cancel() {
      generation += 1;
      metadata?.abort();
      metadata = undefined;
      unsubscribeHistory?.();
      unsubscribeHistory = undefined;
      controller?.getState().returnLive();
      controller?.dispose();
      controller = undefined;
    }
    function exit() {
      cancel();
      themeController.setHistory(false);
      publish({ ...live, pending: false, error: null });
    }
    function seek(time: number) {
      const range = value.range;
      if (!active || !controller || !range || !Number.isFinite(time)) return;
      const requestGeneration = generation;
      void controller
        .getState()
        .seek(Math.max(range.first, Math.min(range.last, time)))
        .catch(() => {
          if (requestGeneration === generation)
            publish({ error: "Could not load recorded state." });
        });
    }
    async function enter() {
      if (
        !active ||
        value.pending ||
        value.mode === "history" ||
        dataStore.getState().projectId !== projectId
      )
        return;
      cancel();
      const requestGeneration = generation;
      const abort = new AbortController();
      metadata = abort;
      publish({ pending: true, error: null });
      try {
        const response = await fetch(`/v1/projects/${encodeURIComponent(projectId)}/timelines`, {
          headers: { [SESSION_HEADER]: secret },
          signal: abort.signal,
        });
        if (!response.ok) throw new Error("metadata");
        const body = await response.json();
        if (!active || requestGeneration !== generation) return;
        if (body?.projectId !== projectId || !Array.isArray(body.timelines))
          throw new Error("metadata");
        const timeline = body.timelines.find(
          (item: { id?: unknown; projectId?: unknown; kind?: unknown } | null) =>
            item?.projectId === projectId &&
            item.id === `live:${projectId}` &&
            item.kind === "live",
        );
        if (!timeline) {
          publish({ pending: false, error: "No recording available." });
          return;
        }
        const first =
          typeof timeline.firstAt === "string" ? Date.parse(timeline.firstAt) : Number.NaN;
        const last = typeof timeline.lastAt === "string" ? Date.parse(timeline.lastAt) : Number.NaN;
        if (!Number.isFinite(first) || !Number.isFinite(last) || first > last)
          throw new Error("metadata");
        controller = createHistoryStore({
          liveStore: dataStore,
          timelineId: timeline.id,
          secret,
          fetch,
          now: Date.now,
        });
        unsubscribeHistory = controller.subscribe((state) => {
          // Live notifications during the initial seek must not clear its range or pending flag.
          // The live subscription below owns project/reset cancellation.
          if (state.mode === "history" && state.state && state.time !== null) {
            replayTime = state.time;
            snapshot.getState().applySnapshotState(state.state);
            snapshot.getState().refreshAttention();
            themeController.setHistory(true);
            publish({
              mode: "history",
              store: snapshot,
              time: state.time,
              pending: false,
              error: null,
            });
          }
        });
        publish({ range: { first, last } });
        await controller.getState().seek(last);
      } catch {
        if (active && requestGeneration === generation) {
          cancel();
          publish({ ...live, pending: false, error: "Could not load recording." });
        }
      }
    }
    value = {
      ...fallback,
      enter: () => {
        void enter();
      },
      seek,
      exit,
    };
    publish({});
    const unsubscribeLive = dataStore.subscribe((next, before) => {
      if (next.projectId !== before.projectId || next.resetGeneration !== before.resetGeneration)
        exit();
    });
    return () => {
      active = false;
      cancel();
      unsubscribeLive();
      themeController.setHistory(false);
    };
  }, [projectId, secret]);
  const value =
    current?.projectId === projectId && current.secret === secret ? current.value : fallback;
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
