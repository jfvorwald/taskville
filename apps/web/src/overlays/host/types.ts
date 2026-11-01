import type { ComponentType } from "react";
import type { ProjectedPoint, ProjectionOptions, Viewport } from "./projection.ts";

/** Where an overlay mounts. The host owns stacking order and which slots are exclusive. */
export const SLOTS = ["header", "sidebar", "timeline", "world-labels", "bubbles"] as const;
export type OverlaySlot = (typeof SLOTS)[number];

/** Slots that hold at most one overlay at a time. Today: the sidebar. */
export const EXCLUSIVE_SLOTS: readonly OverlaySlot[] = ["sidebar"];

/** `live` follows the engine; `history` replays recorded events and must not change the world. */
export type OverlayMode = "live" | "history";

/** ARCHITECTURE.md section 12. */
export interface OverlayDefinition {
  id: string;
  slot: OverlaySlot;
  modes: OverlayMode[];
  Component: ComponentType<OverlayProps>;
}

/** A read-only view of a piece of state, shaped for `useSyncExternalStore`. */
export interface Selector<T> {
  subscribe(listener: () => void): () => void;
  /** Must return the same reference until the value changes. */
  getSnapshot(): T;
}

export interface AgentCounts {
  /** Agents doing work right now. */
  active: number;
  /** Agents waiting on the user. */
  needsYou: number;
}

/** What overlays may read. Grows as the data layer (M3.02) wires more selectors in. */
export interface OverlaySelectors {
  counts: Selector<AgentCounts>;
}

export interface OverlaySelection {
  selectedId: string | null;
  select(id: string | null): void;
}

/** A user intent. It still goes to the engine through the command service, never around it. */
export interface OverlayIntent {
  type: string;
  [field: string]: unknown;
}

export interface OverlayIntents {
  /** False in history mode, where `run` does nothing. */
  readonly available: boolean;
  run(intent: OverlayIntent): void;
}

/** Local settings for one overlay, namespaced by its id. Values must be JSON. */
export interface OverlaySettings {
  /** Returns `fallback` when nothing is stored or the stored value has a different type. */
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

export type WorldPoint = readonly [x: number, y: number, z: number];

/**
 * World anchors: named 3D points (an agent's head, a building's door) that the city publishes
 * and DOM overlays follow. The camera bridge publishes the projection each frame.
 */
export interface AnchorSource {
  setAnchor(id: string, position: WorldPoint): void;
  removeAnchor(id: string): void;
  /** Replaces every anchor whose id starts with `prefix` by `next`, in one notification. */
  replaceAnchors(prefix: string, next: Readonly<Record<string, WorldPoint>>): void;
  getAnchor(id: string): WorldPoint | undefined;
  /** Column-major view-projection matrix (three.js `Matrix4.elements`) and canvas size in CSS px. */
  setProjection(viewProjection: ArrayLike<number>, viewport: Viewport): void;
  /** Screen position inside the layer, or null when the anchor or the camera is unknown. */
  project(id: string, options?: ProjectionOptions): ProjectedPoint | null;
  getViewport(): Viewport | null;
  subscribe(listener: () => void): () => void;
  /** Changes on every anchor or projection change; a snapshot for `useSyncExternalStore`. */
  getVersion(): number;
}

export interface OverlayProps {
  mode: OverlayMode;
  selectors: OverlaySelectors;
  selection: OverlaySelection;
  anchors: AnchorSource;
  intents: OverlayIntents;
  settings: OverlaySettings;
}
