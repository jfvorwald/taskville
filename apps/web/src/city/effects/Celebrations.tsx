import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Shape,
  ShapeGeometry,
} from "three";
import type { StoredEnvelope } from "../../data/domain.ts";
import { type DataStore, dataStore } from "../../data/store.ts";
import type { FidelityFrame } from "../../history/fidelity/frame.ts";
import { type AnchorSource, worldAnchors } from "../../overlays/host/index.ts";
import { debugHookRequested } from "../../testHooks.ts";
import { CITY_LAYOUT, type WorkAreaLayout } from "../layout/index.ts";
import { agentAnchorId, usePrefersReducedMotion } from "../movement/index.ts";
import { type Burst, createBurst } from "./burst.ts";
import { createPlayedHistory } from "./history.ts";
import { SPARKLE_RADIUS, sparkleAnchor } from "./placement.ts";
import type { Celebration } from "./triggers.ts";
import { CONFETTI_DURATION_MS, CONFETTI_MAX_PARTICLES, createCelebrations } from "./triggers.ts";

export interface CelebrationsProps {
  store?: DataStore;
  mode?: "live" | "history";
  fidelity?: FidelityFrame;
  rate?: number;
  anchors?: AnchorSource;
  /** Overrides the system preference (the settings panel will pass its own). */
  reducedMotion?: boolean;
}

const PARTY = ["#ffd166", "#ef476f", "#06d6a0", "#118ab2", "#f78c6b"];
const GOLD = ["#ffd166", "#fff3b0"];
const HIGH_FIVE_PARTICLES = 14;
const HIGH_FIVE_MS = 700;
const MERGE_PARTICLES = 60;
const MERGE_MS = 1600;
const SHIMMER_MS = 1000;
const SHIMMER_PEAK_OPACITY = 0.55;
const SPARKLE_MS = 1200;
/** Height of the roof slab above an area's wall height (the buildings' own constant is private). */
const ROOF_THICKNESS = 0.25;
const HEAD_LIFT = 0.3;

/** `?debug=celebrations` exposes a read-only list of the celebrations played, for end-to-end checks. */
function debugEnabled(): boolean {
  try {
    return debugHookRequested(window.location.search, "celebrations");
  } catch {
    return false;
  }
}

const area = (id: WorkAreaLayout["id"]) => {
  const found = CITY_LAYOUT.areas.find((a) => a.id === id);
  if (found === undefined) throw new Error(`unknown area ${id}`);
  return found;
};

function starGeometry(): ShapeGeometry {
  const shape = new Shape();
  const points = 8;
  for (let i = 0; i < points; i += 1) {
    const r = i % 2 === 0 ? SPARKLE_RADIUS : 0.08;
    const a = (i / points) * Math.PI * 2;
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  shape.closePath();
  return new ShapeGeometry(shape);
}

/**
 * Everything the celebrations draw, allocated once. `play` starts one and returns whether it was
 * drawn (false when a needed agent anchor is missing); `update` advances them.
 */
export function createRig(anchors: AnchorSource) {
  const group = new Group();
  const confetti = createBurst({
    capacity: CONFETTI_MAX_PARTICLES,
    lifetimeMs: CONFETTI_DURATION_MS,
    speed: 2.4,
    size: 0.1,
    gravity: 6,
    colors: PARTY,
  });
  const spark = createBurst({
    capacity: HIGH_FIVE_PARTICLES,
    lifetimeMs: HIGH_FIVE_MS,
    speed: 1.6,
    size: 0.08,
    gravity: 2,
    colors: GOLD,
  });
  const merge = createBurst({
    capacity: MERGE_PARTICLES,
    lifetimeMs: MERGE_MS,
    speed: 4.5,
    size: 0.16,
    gravity: 4,
    colors: PARTY,
  });
  const bursts: readonly Burst[] = [confetti, spark, merge];
  for (const b of bursts) group.add(b.mesh);

  const testLab = area("test_lab");
  const archives = area("archives");
  const shimmerGeometry = new PlaneGeometry(
    testLab.footprint.halfX * 2,
    testLab.footprint.halfZ * 2,
  );
  const shimmerMaterial = new MeshBasicMaterial({
    color: "#4ade80",
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: DoubleSide,
  });
  const shimmer = new Mesh(shimmerGeometry, shimmerMaterial);
  shimmer.rotation.x = -Math.PI / 2;
  shimmer.position.set(
    testLab.footprint.cx,
    testLab.height + ROOF_THICKNESS + 0.02,
    testLab.footprint.cz,
  );
  shimmer.visible = false;
  group.add(shimmer);
  let shimmerAt = Number.NEGATIVE_INFINITY;

  const sparkleGeometry = starGeometry();
  const sparkleMaterial = new MeshBasicMaterial({
    color: "#ffd166",
    side: DoubleSide,
    toneMapped: false,
  });
  const sparkle = new Mesh(sparkleGeometry, sparkleMaterial);
  sparkle.visible = false;
  group.add(sparkle);
  let sparkleAt = Number.NEGATIVE_INFINITY;

  /** Appended at play time only, so the debug probe costs nothing per frame. Bounded. */
  const history = createPlayedHistory();

  const showSparkle = (x: number, y: number, z: number, nowMs: number) => {
    history.push({ kind: "sparkle", at: nowMs });
    sparkle.position.set(x, y, z);
    sparkle.visible = true;
    sparkleAt = nowMs;
  };

  /** Where an agent's head is, or null when the city has not placed it. */
  const head = (id: string) => anchors.getAnchor(agentAnchorId(id)) ?? null;

  return {
    group,
    history,
    play(c: Celebration, event: StoredEnvelope, nowMs: number): boolean {
      switch (c.kind) {
        case "confetti": {
          const p = head(c.agentId);
          if (p) {
            confetti.emit(p[0], p[1] + HEAD_LIFT, p[2], c.particles, nowMs);
            history.push({ kind: "confetti", at: nowMs });
            return true;
          }
          return false;
        }
        case "high-five": {
          const a = head(c.fromAgentId);
          const b = head(c.toAgentId);
          if (a && b) {
            spark.emit(
              (a[0] + b[0]) / 2,
              (a[1] + b[1]) / 2,
              (a[2] + b[2]) / 2,
              HIGH_FIVE_PARTICLES,
              nowMs,
            );
            history.push({ kind: "high-five", at: nowMs });
            return true;
          }
          return false;
        }
        case "merge-burst":
          history.push({ kind: "merge-burst", at: nowMs });
          merge.emit(
            archives.footprint.cx,
            archives.height + ROOF_THICKNESS + 0.5,
            archives.footprint.cz,
            MERGE_PARTICLES,
            nowMs,
          );
          return true;
        case "shimmer":
          shimmerAt = nowMs;
          history.push({ kind: "shimmer", at: nowMs });
          return true;
        case "sparkle": {
          // The reduced-motion icon sits where the full celebration would have played.
          if (c.source === "merge-burst") {
            const at = sparkleAnchor("archives");
            showSparkle(at.x, at.y, at.z, nowMs);
            return true;
          }
          if (c.source === "shimmer") {
            const at = sparkleAnchor("test_lab");
            showSparkle(at.x, at.y, at.z, nowMs);
            return true;
          }
          if (c.source === "high-five" && event.type === "task.handoff") {
            const a = head(event.payload.fromAgentId);
            const b = head(event.payload.toAgentId);
            if (a && b) {
              showSparkle((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.4, (a[2] + b[2]) / 2, nowMs);
              return true;
            }
            return false;
          }
          if (c.agentId !== undefined) {
            const p = head(c.agentId);
            if (p) {
              showSparkle(p[0], p[1] + 0.6, p[2], nowMs);
              return true;
            }
          }
          return false;
        }
      }
    },
    update(nowMs: number, camera: { quaternion: Mesh["quaternion"] }) {
      for (const b of bursts) b.update(nowMs);
      const shimmerT = (nowMs - shimmerAt) / SHIMMER_MS;
      shimmer.visible = shimmerT >= 0 && shimmerT < 1;
      if (shimmer.visible) {
        shimmerMaterial.opacity = SHIMMER_PEAK_OPACITY * Math.sin(Math.PI * shimmerT);
      }
      if (sparkle.visible) {
        if (nowMs - sparkleAt >= SPARKLE_MS) sparkle.visible = false;
        else sparkle.quaternion.copy(camera.quaternion);
      }
    },
    dispose() {
      for (const b of bursts) b.dispose();
      shimmerGeometry.dispose();
      shimmerMaterial.dispose();
      sparkleGeometry.dispose();
      sparkleMaterial.dispose();
    },
  };
}

/**
 * Celebrations for recorded events (ARCHITECTURE.md 2.6): feeds each applied store event to the
 * trigger rules and plays what comes back. Mounted inside the `<Canvas>`.
 */
export function Celebrations({
  store = dataStore,
  mode = "live",
  fidelity,
  rate = 1,
  anchors = worldAnchors,
  reducedMotion,
}: CelebrationsProps) {
  const prefersReduced = usePrefersReducedMotion();
  const reduced = reducedMotion ?? prefersReduced;

  const epoch = fidelity?.epoch;
  // A different presented store or seek epoch must not retain a live or earlier replay burst.
  // biome-ignore lint/correctness/useExhaustiveDependencies: store/mode/epoch fence the rig
  const rig = useMemo(() => createRig(anchors), [anchors, store, mode, epoch]);
  useEffect(() => () => rig.dispose(), [rig]);

  useEffect(() => {
    if (import.meta.env.VITE_TV_TEST_HOOKS !== "1" || !debugEnabled()) return;
    const w = window as unknown as { __taskvilleCelebrations?: () => unknown };
    w.__taskvilleCelebrations = () => rig.history.entries().map((p) => ({ ...p }));
    return () => {
      delete w.__taskvilleCelebrations;
    };
  }, [rig]);

  const baseline = fidelity?.baseline;
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger state resets with its rig
  const celebrations = useMemo(() => {
    const rules = createCelebrations({ now: () => performance.now() });
    // Seed stateful triggers (tests red before green) without drawing or rate limiting a burst.
    for (const event of baseline ?? []) rules.handle(event, () => false);
    return rules;
  }, [baseline, rig]);
  useEffect(() => celebrations.setReducedMotion(reduced), [celebrations, reduced]);
  useEffect(() => celebrations.setSpeed(rate), [celebrations, rate]);

  useEffect(() => {
    if (mode !== "live") return;
    return store.onEvent((event) => {
      celebrations.handle(event, (c) => rig.play(c, event, performance.now()));
    });
  }, [mode, store, celebrations, rig]);

  // A remounted consumer seeds from its position but never redraws a retained crossing.
  const consumed = useRef({ epoch: fidelity?.epoch, revision: fidelity?.revision ?? 0 });
  useFrame((frame) => {
    // CityAgents republishes anchors at priority -1. Consume crossings afterward, so the
    // previous keyed agents' cleanup cannot turn a valid completion into a lost burst.
    if (
      mode === "history" &&
      fidelity &&
      (consumed.current.epoch !== fidelity.epoch || consumed.current.revision !== fidelity.revision)
    ) {
      consumed.current.epoch = fidelity.epoch;
      consumed.current.revision = fidelity.revision;
      celebrations.setSpeed(rate);
      for (const event of fidelity.events) {
        celebrations.handle(event, (c) => rig.play(c, event, performance.now()));
      }
    }
    rig.update(performance.now(), frame.camera);
  });

  return <primitive object={rig.group} />;
}
