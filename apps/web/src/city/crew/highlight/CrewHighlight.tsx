import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  type BufferGeometry,
  Color,
  type Material,
  type Mesh,
  type Object3D,
  type OrthographicCamera,
  RingGeometry,
  Vector3,
} from "three";
import type { Agent } from "../../../data/domain.ts";
import { useData } from "../../../data/react.ts";
import { type DataStore, dataStore } from "../../../data/store.ts";
import { agentColors } from "../../agents/identity.ts";
import type { AgentView } from "../../agents/types.ts";
import { selectionStore } from "../../interaction/selection.ts";
import { easeCameraTo, highlightState } from "./highlightState.ts";
import { type HighlightStore, highlightStore } from "./highlightStore.ts";

const DIM_OPACITY = 0.25;
const BOUNCE_HEIGHT = 0.25;
const BOUNCE_MS = 450;

/** One hop: up and back down over BOUNCE_MS, then nothing. */
function bounceLift(elapsedMs: number): number {
  if (elapsedMs < 0 || elapsedMs >= BOUNCE_MS) return 0;
  return Math.sin((elapsedMs / BOUNCE_MS) * Math.PI) * BOUNCE_HEIGHT;
}
const EASE_PER_SECOND = 6;
const SETTLED = 0.01;
const RING_Y = 0.02;

function viewOf(agent: Agent, parent: Agent | undefined): AgentView {
  return {
    id: agent.id,
    kind: agent.kind,
    activity: "unknown",
    placement: { x: 0, y: 0, z: 0, heading: 0 },
    sourceId: agent.sourceId,
    ...(agent.sourceAgentId === undefined ? {} : { sourceAgentId: agent.sourceAgentId }),
    ...(agent.displayName === undefined ? {} : { displayName: agent.displayName }),
    ...(agent.role === undefined ? {} : { agentType: agent.role }),
    ...(agent.teamId === undefined ? {} : { teamId: agent.teamId }),
    ...(parent === undefined
      ? {}
      : { parentIdentity: `${parent.sourceId}:${parent.sourceAgentId ?? parent.id}` }),
  };
}

function agentGroups(scene: Object3D): Map<string, Object3D> {
  const found = new Map<string, Object3D>();
  scene.traverse((o) => {
    const id = o.userData?.agentId;
    if (typeof id === "string") found.set(id, o);
  });
  return found;
}

/** The faded copies this component made. Only these are ever disposed; pooled materials are not. */
const fades = new WeakSet<Material>();
/** The material a dimmed mesh had before its faded copy went on. */
const originals = new WeakMap<Mesh, Material | Material[]>();

function fade(m: Material): Material {
  if (fades.has(m)) return m;
  const copy = m.clone();
  copy.transparent = true;
  copy.opacity = DIM_OPACITY;
  fades.add(copy);
  return copy;
}

/**
 * Puts a faded copy of each mesh's material on, and the original back. Another system may swap a
 * mesh's material while it is dimmed, so dimming is re-applied every frame: a material that is
 * not one of ours is taken as the new original and faded again.
 */
function setDim(group: Object3D, dim: boolean) {
  group.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const current = mesh.material;
    const list = Array.isArray(current) ? current : [current];
    const ours = list.every((m) => fades.has(m));
    if (dim && !ours) {
      originals.set(mesh, current);
      mesh.material = Array.isArray(current) ? current.map(fade) : fade(current);
    } else if (!dim && ours) {
      const original = originals.get(mesh);
      if (original !== undefined) mesh.material = original;
      originals.delete(mesh);
      for (const m of list) m.dispose();
    }
  });
}

/** Where the object is in the scene, whatever group it sits in. */
function worldOf(o: Object3D): Vector3 {
  return o.getWorldPosition(new Vector3());
}

/**
 * While a Crew tab is open: dims every bot outside the family, outlines the family on the ground
 * in the parent's trim color, draws dotted tethers parent to child, bounces the hovered bot, and
 * eases the camera to a family member the user picks without changing zoom. Renders in the scene.
 */
export function CrewHighlight({
  store = dataStore,
  inputs = highlightStore,
}: {
  store?: DataStore;
  inputs?: HighlightStore;
}) {
  const { openAgentId, hoveredId } = useSyncExternalStore(
    inputs.subscribe,
    inputs.getSnapshot,
    inputs.getSnapshot,
  );
  const agents = useData((s) => s.state?.agents, store);
  const teams = useData((s) => s.state?.teams, store);
  const state = useMemo(
    () =>
      highlightState({ openAgentId, hoveredId, agents: agents ?? {}, ...(teams ? { teams } : {}) }),
    [openAgentId, hoveredId, agents, teams],
  );
  const scene = useThree((s) => s.scene);
  const dimmed = useRef(new Set<string>());
  const lines = useRef(new Map<string, Object3D>());
  const ring = useMemo(() => new RingGeometry(0.45, 0.55, 32).rotateX(-Math.PI / 2), []);
  const trim = useMemo(() => {
    const parent = state.parentId === null ? undefined : agents?.[state.parentId];
    if (parent === undefined) return "#ffffff";
    const grand = parent.parentAgentId === undefined ? undefined : agents?.[parent.parentAgentId];
    return agentColors(viewOf(parent, grand)).trim;
  }, [state.parentId, agents]);
  const target = useRef<{ x: number; z: number } | null>(null);
  const bounced = useRef<{
    id: string | null;
    start: number;
    lifted: { id: string; by: number; y: number } | null;
  }>({ id: null, start: 0, lifted: null });

  // A pick inside the family eases the camera to that bot (zoom is never touched).
  useEffect(() => {
    let last = selectionStore.getSnapshot();
    return selectionStore.subscribe(() => {
      const id = selectionStore.getSnapshot();
      if (id === last) return;
      last = id;
      if (id === null || !state.familyIds.includes(id)) return;
      const at = agentGroups(scene).get(id);
      if (at !== undefined) {
        const world = worldOf(at);
        target.current = { x: world.x, z: world.z };
      }
    });
  }, [scene, state.familyIds]);

  useEffect(
    () => () => {
      for (const group of agentGroups(scene).values()) setDim(group, false);
      dimmed.current.clear();
    },
    [scene],
  );

  const focus = useMemo(() => new Vector3(), []);
  useFrame(({ camera }, delta) => {
    const groups = agentGroups(scene);
    const want = new Set(state.dimmedIds);
    for (const id of [...dimmed.current]) {
      if (want.has(id)) continue;
      const g = groups.get(id);
      if (g !== undefined) setDim(g, false);
      dimmed.current.delete(id);
    }
    // Every frame, not once: a system that swaps a bot's material is dimmed again.
    for (const id of want) {
      const g = groups.get(id);
      if (g === undefined) continue;
      setDim(g, true);
      dimmed.current.add(id);
    }
    // One bounce each time the pointer arrives on a different bot, relative to where the bot's
    // own system put it this frame (it may or may not rewrite the height every frame).
    const now = performance.now();
    const bounce = bounced.current;
    if (bounce.id !== state.bounceId) {
      bounce.id = state.bounceId;
      bounce.start = now;
    }
    const lift = bounce.id === null ? 0 : bounceLift(now - bounce.start);
    const g = bounce.id === null ? undefined : groups.get(bounce.id);
    if (bounce.lifted !== null) {
      const prev = groups.get(bounce.lifted.id);
      if (prev !== undefined && prev.position.y === bounce.lifted.y)
        prev.position.y -= bounce.lifted.by;
      bounce.lifted = null;
    }
    if (g !== undefined && lift > 0) {
      g.position.y += lift;
      bounce.lifted = { id: bounce.id as string, by: lift, y: g.position.y };
    }
    // Tethers follow the bots, so their end points are rewritten each frame.
    for (const [key, line] of lines.current) {
      const [from, to] = key.split("|");
      const a = from === undefined ? undefined : groups.get(from);
      const b = to === undefined ? undefined : groups.get(to);
      if (a === undefined || b === undefined) continue;
      const segments = line as unknown as {
        geometry: BufferGeometry;
        computeLineDistances(): void;
      };
      segments.geometry.setFromPoints([worldOf(a), worldOf(b)]);
      segments.computeLineDistances();
    }
    const goal = target.current;
    if (goal !== null && (camera as OrthographicCamera).isOrthographicCamera === true) {
      // Where the camera looks on the ground: its position slid along its view direction to y = 0.
      camera.getWorldDirection(focus);
      const t = -camera.position.y / focus.y;
      const at = { x: camera.position.x + focus.x * t, z: camera.position.z + focus.z * t };
      const next = easeCameraTo({ ...at, zoom: camera.zoom }, goal);
      const dx = next.x - at.x;
      const dz = next.z - at.z;
      const k = Math.min(1, delta * EASE_PER_SECOND);
      camera.position.x += dx * k;
      camera.position.z += dz * k;
      if (Math.abs(dx) + Math.abs(dz) < SETTLED) target.current = null;
    }
  });

  if (!state.active) return null;
  const color = new Color(trim);
  return (
    <group name="crew-highlight">
      {state.familyIds.map((id) => (
        <FollowRing key={id} id={id} geometry={ring} color={color} />
      ))}
      {state.tethers.map((t) => (
        <lineSegments
          key={`${t.from}|${t.to}`}
          ref={(o) => {
            if (o === null) lines.current.delete(`${t.from}|${t.to}`);
            else lines.current.set(`${t.from}|${t.to}`, o);
          }}
        >
          <bufferGeometry />
          <lineDashedMaterial color={color} dashSize={0.15} gapSize={0.15} />
        </lineSegments>
      ))}
    </group>
  );
}

function FollowRing({
  id,
  geometry,
  color,
}: {
  id: string;
  geometry: BufferGeometry;
  color: Color;
}) {
  const mesh = useRef<Mesh>(null);
  const scene = useThree((s) => s.scene);
  useFrame(() => {
    const at = agentGroups(scene).get(id);
    if (at !== undefined && mesh.current !== null) {
      const world = worldOf(at);
      mesh.current.position.set(world.x, RING_Y, world.z);
    }
  });
  return (
    <mesh ref={mesh} geometry={geometry}>
      <meshBasicMaterial color={color} />
    </mesh>
  );
}
