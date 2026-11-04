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
import { type CameraRig, cameraRig } from "../../interaction/cameraRig.ts";
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

type Groups = Map<string, Object3D>;

function agentGroups(scene: Object3D): Groups {
  const found: Groups = new Map();
  scene.traverse((o) => {
    const id = o.userData?.agentId;
    if (typeof id === "string") found.set(id, o);
  });
  return found;
}

/**
 * The id-to-group map, walked at most once per draw however many rings and tethers ask. It is
 * dropped after each draw of the scene, so it never outlives the frame (a stopped clock included).
 */
const frameGroups = new WeakMap<Object3D, Groups>();
function groupsOf(scene: Object3D): Groups {
  const known = frameGroups.get(scene);
  if (known !== undefined) return known;
  const groups = agentGroups(scene);
  frameGroups.set(scene, groups);
  return groups;
}

/** The faded copies this component made. Only these are ever disposed; pooled materials are not. */
const fades = new WeakSet<Material>();
/** One faded copy per source material, so a material swapped back every frame is not cloned again. */
const fadeOf = new Map<Material, Material>();
/** The material a dimmed mesh had before its faded copy went on. */
const originals = new WeakMap<Mesh, Material | Material[]>();

function fade(m: Material): Material {
  if (fades.has(m)) return m;
  const known = fadeOf.get(m);
  if (known !== undefined) return known;
  const copy = m.clone();
  fadeOf.set(m, copy);
  copy.transparent = true;
  copy.depthWrite = false;
  copy.opacity = DIM_OPACITY;
  fades.add(copy);
  return copy;
}

/**
 * Puts a faded copy of each mesh's material on, and the original back. Another system may swap a
 * mesh's material while it is dimmed, so dimming is re-applied every frame and again just before
 * each draw: a material that is not one of ours is taken as the new original and faded again.
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
    }
  });
}

/** Disposes every faded copy; called once nothing is dimmed, so no mesh still shows one. */
function disposeFades() {
  for (const copy of fadeOf.values()) copy.dispose();
  fadeOf.clear();
}

/** Where the object is in the scene, whatever group it sits in. */
function worldOf(o: Object3D): Vector3 {
  return o.getWorldPosition(new Vector3());
}

interface Lifted {
  id: string;
  by: number;
  y: number;
}

/**
 * While a Crew tab is open: dims every bot outside the family, outlines the family on the ground
 * in the parent's trim color, draws dotted tethers parent to child, bounces the hovered bot, and
 * eases the camera to a family member the user picks without changing zoom. Renders in the scene.
 *
 * Other layers (SubagentCrew, AgentBlock) rewrite a bot's height and materials in their own frame
 * callbacks, in whatever order they registered. So the dim and the lift are applied in the frame
 * callback and again just before each draw, by wrapping the renderer's `render`.
 */
export function CrewHighlight({
  store = dataStore,
  inputs = highlightStore,
  rig = cameraRig,
  reducedMotion = false,
}: {
  store?: DataStore;
  inputs?: HighlightStore;
  /** The rig the city's CameraDriver reads; a pick pans it, so an orbited camera still follows. */
  rig?: CameraRig;
  /** No bounce, and the camera moves in one step. */
  reducedMotion?: boolean;
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
  const gl = useThree((s) => s.gl);
  const dimmed = useRef(new Set<string>());
  const ring = useMemo(() => new RingGeometry(0.45, 0.55, 32).rotateX(-Math.PI / 2), []);
  const trim = useMemo(() => {
    const parent = state.parentId === null ? undefined : agents?.[state.parentId];
    if (parent === undefined) return "#ffffff";
    const grand = parent.parentAgentId === undefined ? undefined : agents?.[parent.parentAgentId];
    return agentColors(viewOf(parent, grand)).trim;
  }, [state.parentId, agents]);
  const target = useRef<{ x: number; z: number } | null>(null);
  const bounce = useRef<{ id: string | null; start: number; lifted: Lifted | null }>({
    id: null,
    start: 0,
    lifted: null,
  });
  const latest = useRef({ state, reducedMotion });
  latest.current = { state, reducedMotion };

  // Test hook (M3.19 style): the highlight is drawn in WebGL, so e2e reads its state here instead.
  useEffect(() => {
    if (import.meta.env.VITE_TV_TEST_HOOKS !== "1") return;
    const w = window as unknown as { __taskvilleCrewHighlight?: () => unknown };
    w.__taskvilleCrewHighlight = () => {
      const { parentId, familyIds, dimmedIds } = latest.current.state;
      if (parentId === null) return null;
      return { parentId, familyIds: [...familyIds], dimmedIds: [...dimmedIds] };
    };
    return () => {
      delete w.__taskvilleCrewHighlight;
    };
  }, []);

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

  // Reset (or any return to the default view) during an ease ends it.
  useEffect(
    () =>
      rig.subscribe(() => {
        if (rig.isDefault()) target.current = null;
      }),
    [rig],
  );

  // Brings the dim and the lift up to date on the given bots. Safe to call any number of times a
  // frame: the lift is taken off where it was left (if the bot's own system did not already
  // overwrite it) before it is put on again.
  const sync = useRef((_groups: Groups) => {});
  sync.current = (groups) => {
    const now = latest.current.state;
    const want = new Set(now.dimmedIds);
    for (const id of [...dimmed.current]) {
      if (want.has(id)) continue;
      const g = groups.get(id);
      if (g !== undefined) setDim(g, false);
      dimmed.current.delete(id);
    }
    for (const id of want) {
      const g = groups.get(id);
      if (g === undefined) continue;
      setDim(g, true);
      dimmed.current.add(id);
    }
    if (dimmed.current.size === 0) disposeFades();

    // One bounce each time the pointer arrives on a different bot.
    const clock = performance.now();
    const b = bounce.current;
    if (b.id !== now.bounceId) {
      b.id = now.bounceId;
      b.start = clock;
    }
    const lift = b.id === null || latest.current.reducedMotion ? 0 : bounceLift(clock - b.start);
    if (b.lifted !== null) {
      const prev = groups.get(b.lifted.id);
      if (prev !== undefined && prev.position.y === b.lifted.y) prev.position.y -= b.lifted.by;
      b.lifted = null;
    }
    const g = b.id === null ? undefined : groups.get(b.id);
    if (b.id !== null && g !== undefined && lift > 0) {
      g.position.y += lift;
      b.lifted = { id: b.id, by: lift, y: g.position.y };
    }
  };
  // Nothing to dim, lift or undo: the frame and the draw then cost nothing.
  const idleRef = useRef<() => boolean>(() => true);
  idleRef.current = () =>
    !latest.current.state.active &&
    dimmed.current.size === 0 &&
    bounce.current.id === null &&
    bounce.current.lifted === null;

  // Just before each draw, after every frame callback has run: put the dim and the lift back.
  useEffect(() => {
    const draw = gl.render;
    // Set when another wrapper was installed over this one and this one can no longer be removed.
    let dead = false;
    const wrapper: typeof gl.render = (renderScene, camera) => {
      // Only the main scene: a RenderTexture, Hud or portal scene must not sync or forget state.
      const main = renderScene === scene;
      if (!dead && main && !idleRef.current()) sync.current(agentGroups(renderScene));
      draw.call(gl, renderScene, camera);
      if (main) frameGroups.delete(scene);
    };
    gl.render = wrapper;
    return () => {
      // Restore only if still the current wrapper; otherwise pass through and leave gl.render be.
      if (gl.render === wrapper) gl.render = draw;
      else dead = true;
      const groups = agentGroups(scene);
      const b = bounce.current;
      if (b.lifted !== null) {
        const prev = groups.get(b.lifted.id);
        if (prev !== undefined && prev.position.y === b.lifted.y) prev.position.y -= b.lifted.by;
        b.lifted = null;
      }
      for (const group of groups.values()) setDim(group, false);
      dimmed.current.clear();
      disposeFades();
    };
  }, [gl, scene]);

  const focus = useMemo(() => new Vector3(), []);
  useFrame(({ camera, invalidate }, delta) => {
    if (target.current === null && idleRef.current()) return;
    if (!idleRef.current()) sync.current(groupsOf(scene));
    // The hop and the dim need a draw per frame while they run, even on demand rendering.
    if (bounce.current.lifted !== null) invalidate();
    const goal = target.current;
    if (goal !== null && (camera as OrthographicCamera).isOrthographicCamera === true) {
      // Where the camera looks on the ground: its position slid along its view direction to y = 0.
      camera.getWorldDirection(focus);
      const t = -camera.position.y / focus.y;
      const at = { x: camera.position.x + focus.x * t, z: camera.position.z + focus.z * t };
      const next = easeCameraTo({ ...at, zoom: camera.zoom }, goal);
      const dx = next.x - at.x;
      const dz = next.z - at.z;
      const k = reducedMotion ? 1 : Math.min(1, delta * EASE_PER_SECOND);
      // Through the rig, so CameraDriver keeps turn and zoom and applies the move itself.
      rig.panBy(dx * k, dz * k);
      if (reducedMotion || Math.abs(dx) + Math.abs(dz) < SETTLED) target.current = null;
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
        <Tether key={`${t.from}>${t.to}`} from={t.from} to={t.to} color={color} />
      ))}
    </group>
  );
}

/** Whether the object and every ancestor are visible. */
function isShown(o: Object3D): boolean {
  for (let at: Object3D | null = o; at !== null; at = at.parent) if (!at.visible) return false;
  return true;
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
    if (mesh.current === null) return;
    const at = groupsOf(scene).get(id);
    // No visible bot (finished and gone, or hidden behind a crew marker): no ring.
    mesh.current.visible = at !== undefined && isShown(at);
    if (at !== undefined) {
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

/** A dotted line parent to child. Its end points are rewritten only when a bot has moved. */
function Tether({ from, to, color }: { from: string; to: string; color: Color }) {
  const line = useRef<Object3D>(null);
  const ends = useRef<{ a: Vector3; b: Vector3 } | null>(null);
  const scene = useThree((s) => s.scene);
  useFrame(() => {
    const segments = line.current as unknown as {
      geometry: BufferGeometry;
      computeLineDistances(): void;
    } | null;
    if (segments === null) return;
    const groups = groupsOf(scene);
    const a = groups.get(from);
    const b = groups.get(to);
    if (a === undefined || b === undefined) return;
    const pa = worldOf(a);
    const pb = worldOf(b);
    const last = ends.current;
    if (last?.a.equals(pa) && last.b.equals(pb)) return;
    ends.current = { a: pa, b: pb };
    segments.geometry.setFromPoints([pa, pb]);
    segments.computeLineDistances();
  });
  return (
    // The geometry is rewritten each frame and its bounding sphere is not, so it is never culled.
    <lineSegments ref={line} frustumCulled={false}>
      <bufferGeometry />
      <lineDashedMaterial color={color} dashSize={0.15} gapSize={0.15} />
    </lineSegments>
  );
}
