/** The part of `Document` the watcher needs, so it runs against a fake in node. */
export interface VisibilityDocument {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface VisibilityHandlers {
  now(): number;
  onPause(): void;
  onResume(info: { hiddenForMs: number }): void;
}

/**
 * ARCHITECTURE.md section 2.8: a hidden tab pauses animation and the presentation is rebuilt on
 * return. Calls `onPause` when the tab hides (at once if it starts hidden) and `onResume` when it
 * is shown again. Returns a function that stops listening.
 */
export function watchVisibility(doc: VisibilityDocument, handlers: VisibilityHandlers): () => void {
  let hiddenSince: number | null = null;
  const sync = () => {
    const hidden = doc.visibilityState === "hidden";
    if (hidden && hiddenSince === null) {
      hiddenSince = handlers.now();
      handlers.onPause();
    } else if (!hidden && hiddenSince !== null) {
      const hiddenForMs = handlers.now() - hiddenSince;
      hiddenSince = null;
      handlers.onResume({ hiddenForMs });
    }
  };
  doc.addEventListener("visibilitychange", sync);
  sync();
  return () => doc.removeEventListener("visibilitychange", sync);
}
