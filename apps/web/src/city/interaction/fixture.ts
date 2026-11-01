import { worldAnchors } from "../../overlays/host/index.ts";
import { type TestHooksEnv, testHooksEnabled } from "../../testHooks.ts";
import type { AgentView } from "../agents/index.ts";
import { CITY_LAYOUT } from "../layout/index.ts";

/**
 * Two fixed agents for the interaction e2e test and for looking at the camera by hand. They are
 * mounted only when the page URL has `?tv-fixture=agents`; the real agents come from the data
 * layer and navigation (M3.05 and M3.06), which are not mounted on this branch.
 *
 * - `fixture-front` stands at the first workstation of Dispatch, with nothing in front of it.
 * - `fixture-hidden` stands just north-west of Review, so Review is between it and the camera.
 */
export const FIXTURE_FRONT_ID = "fixture-front";
export const FIXTURE_HIDDEN_ID = "fixture-hidden";

export function fixtureAgents(): AgentView[] {
  const slot = CITY_LAYOUT.slots.find((s) => s.id === "dispatch:1");
  const review = CITY_LAYOUT.areas.find((a) => a.id === "review");
  const front = { x: slot?.x ?? -10.6, z: slot?.z ?? -6.7 };
  const hidden = review
    ? {
        x: review.footprint.cx - review.footprint.halfX - 0.6,
        z: review.footprint.cz - review.footprint.halfZ - 0.6,
      }
    : { x: 6.8, z: 6.8 };
  return [
    {
      id: FIXTURE_FRONT_ID,
      kind: "session",
      displayName: "Front",
      activity: "idle",
      placement: { x: front.x, y: 0, z: front.z, heading: 0 },
    },
    {
      id: FIXTURE_HIDDEN_ID,
      kind: "session",
      displayName: "Hidden",
      activity: "idle",
      placement: { x: hidden.x, y: 0, z: hidden.z, heading: 0 },
    },
  ];
}

export function fixtureRequested(search: string, env?: TestHooksEnv): boolean {
  return testHooksEnabled(env) && new URLSearchParams(search).get("tv-fixture") === "agents";
}

declare global {
  interface Window {
    /** Fixture mode only: screen position (CSS px from the canvas top-left) of a fixture anchor. */
    __tvProbe?: (anchorId: string) => { x: number; y: number } | null;
  }
}

/**
 * Fixture mode only. Publishes world anchors for the fixture agents, one building and a bit of
 * empty ground, and a `window.__tvProbe(id)` that reports where the live camera puts them, so the
 * e2e test clicks where things really are instead of re-deriving the camera.
 */
export function installFixtureProbe(agents: readonly AgentView[]): () => void {
  const points: Record<string, readonly [number, number, number]> = {
    "fixture:empty": [0, 0, 14],
  };
  for (const a of agents) points[`fixture:${a.id}`] = [a.placement.x, 0.55, a.placement.z];
  const review = CITY_LAYOUT.areas.find((a) => a.id === "review");
  if (review) points["fixture:review"] = [review.footprint.cx, 2, review.footprint.cz];
  worldAnchors.replaceAnchors("fixture:", points);
  window.__tvProbe = (id) => {
    const p = worldAnchors.project(id, { margin: 1000 });
    return p === null ? null : { x: p.x, y: p.y };
  };
  return () => {
    worldAnchors.replaceAnchors("fixture:", {});
    delete window.__tvProbe;
  };
}
