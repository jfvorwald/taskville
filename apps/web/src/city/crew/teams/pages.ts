import { useCallback, useSyncExternalStore } from "react";
import type { DataStore } from "../../../data/store.ts";
import { dispatchQueue } from "./queue.ts";

export const QUEUE_PAGE_SIZE = 6;

/** Presentation state shared by the DOM and canvas, isolated to their data store. */
function createPages(store: DataStore) {
  const pages = new Map<string, { startedAt: string; page: number }>();
  const listeners = new Set<() => void>();
  let projectId = store.getState().projectId;
  let unsubscribe: (() => void) | undefined;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const sync = () => {
    const data = store.getState();
    if (data.projectId !== projectId || data.state === null) pages.clear();
    projectId = data.projectId;
    for (const [id, entry] of pages) {
      const team = data.state?.teams[id];
      if (!team || team.endedAt !== undefined || team.startedAt !== entry.startedAt) {
        pages.delete(id);
      } else if (data.state) {
        entry.page = Math.min(entry.page, lastPage(id));
      }
    }
    notify();
  };
  const lastPage = (id: string) => {
    const state = store.getState().state;
    return Math.max(
      0,
      Math.ceil((state ? dispatchQueue(state, id).length : 0) / QUEUE_PAGE_SIZE) - 1,
    );
  };
  return {
    subscribe(listener: () => void) {
      if (listeners.size === 0) {
        sync();
        unsubscribe = store.subscribe(sync);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribe?.();
          pages.clear();
        }
      };
    },
    page: (id: string) => Math.min(pages.get(id)?.page ?? 0, lastPage(id)),
    move(id: string, direction: number) {
      const team = store.getState().state?.teams[id];
      if (!team || team.endedAt !== undefined) return;
      const page = pages.get(id)?.page ?? 0;
      pages.set(id, {
        startedAt: team.startedAt,
        page: Math.max(0, Math.min(lastPage(id), page + direction)),
      });
      notify();
    },
  };
}

const controllers = new WeakMap<DataStore, ReturnType<typeof createPages>>();

export function useQueuePage(store: DataStore, teamId: string) {
  let pages = controllers.get(store);
  if (!pages) {
    pages = createPages(store);
    controllers.set(store, pages);
  }
  const controller = pages;
  const snapshot = useCallback(() => controller.page(teamId), [controller, teamId]);
  const page = useSyncExternalStore(controller.subscribe, snapshot, snapshot);
  return { page, move: (direction: number) => controller.move(teamId, direction) };
}
