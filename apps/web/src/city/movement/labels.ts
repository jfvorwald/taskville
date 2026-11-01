import type { AgentLabelEntry } from "../agents/types.ts";
import type { PresentationState } from "./navigator.ts";

// What the agent-labels overlay draws. The text is the recorded state (M3.05 `agentLabel`), so it
// is right the moment an event arrives; navigation only adds the "on the way" mark.

export interface MovementLabel {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly onTheWay: boolean;
  readonly state: PresentationState;
  /** Needs you: wins label collisions. */
  readonly urgent: boolean;
}

export interface Presentation {
  readonly state: PresentationState;
  readonly onTheWay: boolean;
}

export function labelRows(
  entries: readonly AgentLabelEntry[],
  presentationFor: (id: string) => Presentation | undefined,
  urgent: ReadonlySet<string> = new Set(),
): MovementLabel[] {
  return entries.map((e) => {
    const p = presentationFor(e.id);
    return {
      id: e.id,
      name: e.name,
      status: e.status,
      onTheWay: p?.onTheWay ?? false,
      state: p?.state ?? "idle",
      urgent: urgent.has(e.id),
    };
  });
}

export interface LabelStore {
  /** Keeps the current snapshot (and notifies nobody) when `rows` are equal to it. */
  set(rows: readonly MovementLabel[]): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly MovementLabel[];
}

const sameRow = (a: MovementLabel, b: MovementLabel) =>
  a.id === b.id &&
  a.name === b.name &&
  a.status === b.status &&
  a.onTheWay === b.onTheWay &&
  a.state === b.state &&
  a.urgent === b.urgent;

export function createLabelStore(): LabelStore {
  let rows: readonly MovementLabel[] = [];
  const listeners = new Set<() => void>();
  return {
    set(next) {
      if (next.length === rows.length && next.every((r, i) => sameRow(r, rows[i] as MovementLabel)))
        return;
      rows = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => rows,
  };
}

/** The app-wide label store: the city writes it, the agent-labels overlay reads it. */
export const movementLabels: LabelStore = createLabelStore();
