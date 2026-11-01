import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  BackSide,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  RingGeometry,
  Vector3,
} from "three";
import { AgentsLayer } from "../agents/index.ts";
import { windowSites } from "../buildings/parts.ts";
import { CITY_CAMERA, CITY_LAYOUT } from "../layout/index.ts";
import { CameraDriver } from "./CameraDriver.tsx";
import { type CameraRig, cameraRig } from "./cameraRig.ts";
import { shouldClearOnEscape } from "./escape.ts";
import { createBuildingFader } from "./fade.ts";
import { fixtureAgents, fixtureRequested, installFixtureProbe } from "./fixture.ts";
import { markHoverDirtyOnCameraChange, repickOnCameraChange } from "./hover.ts";
import { createHullGlow } from "./hull.ts";
import { markOccluders, viewDirection } from "./occlusion.ts";
import { collectPickables, createPicker, ownerOf } from "./pick.ts";
import { shouldSelectOnRelease } from "./pointer.ts";
import {
  type ParsedSelection,
  parseSelectionId,
  type SelectionStore,
  selectionAfterRescan,
  selectionStore,
} from "./selection.ts";

export interface InteractionLayerProps {
  store?: SelectionStore;
  rig?: CameraRig;
  /** Rim glow color. Defaults to the `--tv-accent` token. */
  glowColor?: string | undefined;
  /** Selection marker color. Defaults to the `--tv-focus` token. */
  markerColor?: string | undefined;
  /**
   * Whether to skip animation (the occlusion fade completes at once). Defaults to the OS
   * `prefers-reduced-motion` setting when not given.
   */
  reducedMotion?: boolean | undefined;
}

const CLICK_SLOP_PX = 4;
const DRAG_DEGREES_PER_PX = 0.35;
const WHEEL_ZOOM_PER_UNIT = 0.0015;
const GLOW_THICKNESS = 0.045;
const OCCLUDER_PAD = 0.3;
const SOLID_ABOVE = 0.99;
/** A building this faded is looked through: it cannot be hovered or clicked. */
const LOOK_THROUGH_BELOW = 0.6;
const LOST_TARGET_RETRY_SECONDS = 0.5;
const MARKER_LIFT = 0.04;
const FADE_SECONDS = 0.25;

const tmpPosition = new Vector3();
const tmpScale = new Vector3();
const eye = { x: 0, y: 0, z: 0 };
const toCamera = { x: 0, y: 0, z: 0 };
const AREAS = CITY_LAYOUT.areas;
const AREA_INDEX = new Map(AREAS.map((a, i) => [a.id as string, i]));

function cssToken(name: `--${string}`, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === "" ? fallback : v;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Everything the user does to the city with the pointer, mounted inside the scene's `<Canvas>`
 * after `CityScene`:
 *
 * - hover: the thing under the pointer (an agent or a building) gets a rim glow, an inverted
 *   hull, and the cursor becomes a pointer;
 * - click: selects it (`store`), or clears the selection over empty ground; Escape clears too;
 * - drag turns the camera, the wheel zooms (`rig`, applied by `CameraDriver`);
 * - the selected agent or building gets a marker on the ground, and when an agent is selected the
 *   buildings between it and the camera fade out.
 *
 * Nothing is allocated per frame. A pointer move that finds a new target does the work of one
 * pick (three.js allocates its hit points).
 */
export function InteractionLayer({
  store = selectionStore,
  rig = cameraRig,
  glowColor,
  markerColor,
  reducedMotion,
}: InteractionLayerProps) {
  const fixture = useMemo(
    () =>
      import.meta.env.VITE_TV_TEST_HOOKS === "1" &&
      typeof window !== "undefined" &&
      fixtureRequested(window.location.search)
        ? fixtureAgents()
        : null,
    [],
  );
  useEffect(() => {
    if (import.meta.env.VITE_TV_TEST_HOOKS !== "1") return;
    return fixture === null ? undefined : installFixtureProbe(fixture);
  }, [fixture]);
  return (
    <>
      <CameraDriver rig={rig} />
      <Interaction
        store={store}
        rig={rig}
        glowColor={glowColor}
        markerColor={markerColor}
        reducedMotion={reducedMotion}
      />
      {fixture !== null && <AgentsLayer agents={fixture} />}
    </>
  );
}

function Interaction({
  store,
  rig,
  glowColor,
  markerColor,
  reducedMotion,
}: Required<Pick<InteractionLayerProps, "store" | "rig">> &
  Pick<InteractionLayerProps, "glowColor" | "markerColor" | "reducedMotion">) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);

  const picker = useMemo(() => createPicker(), []);
  const pickables = useMemo<Object3D[]>(() => [], []);
  const sites = useMemo(() => windowSites(CITY_LAYOUT), []);
  const fader = useMemo(() => createBuildingFader({ sites }), [sites]);
  const reduced = reducedMotion ?? prefersReducedMotion();
  useEffect(() => {
    fader.setSeconds(reduced ? 0 : FADE_SECONDS);
  }, [fader, reduced]);
  const glowMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: glowColor ?? cssToken("--tv-accent", "#6ea8d9"),
        side: BackSide,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
    [glowColor],
  );
  const glow = useMemo(() => createHullGlow(glowMaterial, GLOW_THICKNESS), [glowMaterial]);

  const markerMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: markerColor ?? cssToken("--tv-focus", "#f2c14e"),
        side: DoubleSide,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false,
      }),
    [markerColor],
  );
  const [circle, square] = useMemo(() => {
    const c = new Mesh(new RingGeometry(0.62, 0.8, 40), markerMaterial);
    const s = new Mesh(new RingGeometry(0.9, 1, 4, 1, Math.PI / 4), markerMaterial);
    for (const m of [c, s]) {
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 10;
      m.visible = false;
      m.raycast = () => {};
    }
    return [c, s];
  }, [markerMaterial]);

  useEffect(() => {
    scene.add(circle, square);
    return () => {
      scene.remove(circle, square);
      circle.geometry.dispose();
      square.geometry.dispose();
      markerMaterial.dispose();
    };
  }, [scene, circle, square, markerMaterial]);

  useEffect(
    () => () => {
      glow.detach();
      glowMaterial.dispose();
    },
    [glow, glowMaterial],
  );
  useEffect(() => () => fader.dispose(), [fader]);

  // Mutable state read by the frame loop and the pointer handlers.
  const st = useRef({
    sel: parseSelectionId(store.getSnapshot()) as ParsedSelection | null,
    selectedObject: null as Object3D | null,
    seen: false,
    retry: 0,
    hoverId: null as string | null,
    hoverControl: false,
    hoverDirty: false,
    inside: false,
    ndcX: 0,
    ndcY: 0,
    down: false,
    moved: false,
    downX: 0,
    downY: 0,
    lastX: 0,
    lastY: 0,
    buildings: null as Object3D | null,
    mask: [] as boolean[],
    facing: 0,
    fadedKey: "",
  });

  useEffect(() => {
    st.current.sel = parseSelectionId(store.getSnapshot());
    st.current.selectedObject = null;
    st.current.seen = false;
    return store.subscribe(() => {
      st.current.sel = parseSelectionId(store.getSnapshot());
      st.current.selectedObject = null;
      st.current.seen = false;
      st.current.retry = 0;
    });
  }, [store]);

  useEffect(
    () =>
      markHoverDirtyOnCameraChange(
        rig,
        () => {
          st.current.hoverDirty = true;
        },
        () =>
          repickOnCameraChange({
            inside: st.current.inside,
            dragging: st.current.down && st.current.moved,
          }),
      ),
    [rig],
  );

  const isFaded = useRef<(id: string) => boolean>(() => false);
  isFaded.current = (id: string) =>
    id.startsWith("area:") && fader.opacityOf(id.slice("area:".length)) < LOOK_THROUGH_BELOW;

  const pickAt = useCallback(
    (clientX: number, clientY: number): string | null => {
      const rect = gl.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const x = ((clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((clientY - rect.top) / rect.height) * 2 + 1;
      collectPickables(scene, pickables);
      camera.updateMatrixWorld();
      return picker.pick(x, y, camera, pickables, isFaded.current);
    },
    [gl, scene, camera, picker, pickables],
  );

  useEffect(() => {
    const dom = gl.domElement;
    const s = st.current;
    dom.style.touchAction = "none";

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      s.down = true;
      s.moved = false;
      s.downX = s.lastX = e.clientX;
      s.downY = s.lastY = e.clientY;
      dom.setPointerCapture?.(e.pointerId);
    };
    const onEnter = () => {
      s.inside = true;
    };
    const onMove = (e: PointerEvent) => {
      s.inside = true;
      if (s.down) {
        if (!s.moved && Math.hypot(e.clientX - s.downX, e.clientY - s.downY) > CLICK_SLOP_PX) {
          s.moved = true;
          dom.style.cursor = "grabbing";
        }
        if (s.moved) {
          rig.orbitBy(-(e.clientX - s.lastX) * DRAG_DEGREES_PER_PX);
          s.lastX = e.clientX;
          s.lastY = e.clientY;
        }
        return;
      }
      const rect = dom.getBoundingClientRect();
      s.ndcX = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
      s.ndcY = -((e.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1;
      s.hoverDirty = true;
    };
    const onUp = (e: PointerEvent) => {
      if (!s.down) return;
      s.down = false;
      dom.releasePointerCapture?.(e.pointerId);
      if (s.moved) {
        dom.style.cursor = "";
        s.hoverDirty = true;
      }
      if (shouldSelectOnRelease({ type: e.type, moved: s.moved })) {
        const id = pickAt(e.clientX, e.clientY);
        if (picker.control === null) store.select(id);
      }
    };
    const onLeave = () => {
      s.inside = false;
      s.hoverDirty = false;
      s.hoverControl = false;
      dom.style.cursor = "";
      if (s.hoverId !== null) {
        s.hoverId = null;
        glow.detach();
        dom.style.cursor = "";
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      rig.zoomBy(Math.exp(-e.deltaY * WHEEL_ZOOM_PER_UNIT));
    };
    const onKey = (e: KeyboardEvent) => {
      if (shouldClearOnEscape(e)) store.select(null);
    };

    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointerenter", onEnter);
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerup", onUp);
    dom.addEventListener("pointercancel", onUp);
    dom.addEventListener("pointerleave", onLeave);
    dom.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointerenter", onEnter);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerup", onUp);
      dom.removeEventListener("pointercancel", onUp);
      dom.removeEventListener("pointerleave", onLeave);
      dom.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      dom.style.cursor = "";
      dom.style.touchAction = "";
    };
  }, [gl, rig, store, glow, pickAt, picker]);

  const wanted = useRef<(id: string) => boolean>(() => false);
  wanted.current = (id: string) => {
    const i = AREA_INDEX.get(id);
    return i !== undefined && st.current.mask[i] === true;
  };

  useFrame((_state, delta) => {
    const s = st.current;

    // Hover: at most one pick per frame, only when the pointer moved.
    if (s.hoverDirty) {
      s.hoverDirty = false;
      collectPickables(scene, pickables);
      camera.updateMatrixWorld();
      const id = picker.pick(s.ndcX, s.ndcY, camera, pickables, isFaded.current);
      const control = picker.control !== null;
      if (id !== s.hoverId || control !== s.hoverControl) {
        s.hoverId = id;
        s.hoverControl = control;
        glow.detach();
        if (id !== null) {
          for (const p of pickables) {
            if (ownerOf(p) === id) {
              glow.attach(p);
              break;
            }
          }
        }
        gl.domElement.style.cursor = id === null && !control ? "" : "pointer";
      }
    }

    // Selected thing: marker and occluders.
    const sel = s.sel;
    circle.visible = false;
    square.visible = false;
    let occluding = false;

    if (sel?.kind === "agent") {
      let obj = s.selectedObject;
      if (obj !== null && obj.parent === null) obj = s.selectedObject = null;
      if (obj === null) {
        s.retry -= delta;
        if (s.retry <= 0) {
          s.retry = LOST_TARGET_RETRY_SECONDS;
          collectPickables(scene, pickables);
          for (const p of pickables) {
            if (p.userData.agentId === sel.id) {
              obj = s.selectedObject = p;
              break;
            }
          }
          // An agent that was there and is gone clears its selection; one not mounted yet waits.
          const rescan = selectionAfterRescan({ seen: s.seen, found: obj !== null });
          s.seen = rescan.seen;
          if (rescan.clear) store.select(null);
        }
      }
      if (obj !== null) {
        obj.getWorldPosition(tmpPosition);
        obj.getWorldScale(tmpScale);
        circle.position.set(tmpPosition.x, tmpPosition.y + MARKER_LIFT, tmpPosition.z);
        const r = 0.55 * tmpScale.x + 0.15;
        circle.scale.set(r, r, r);
        circle.visible = true;
        eye.x = tmpPosition.x;
        eye.y = tmpPosition.y + 0.5 * tmpScale.y;
        eye.z = tmpPosition.z;
        viewDirection(
          CITY_CAMERA.azimuth + rig.getSnapshot().azimuthOffset,
          CITY_CAMERA.elevation,
          toCamera,
        );
        markOccluders(eye, toCamera, AREAS, OCCLUDER_PAD, s.mask);
        occluding = true;
      }
    } else if (sel?.kind === "area") {
      const i = AREA_INDEX.get(sel.id);
      const area = i === undefined ? undefined : AREAS[i];
      if (area !== undefined) {
        const f = area.footprint;
        square.position.set(f.cx, MARKER_LIFT, f.cz);
        // The square ring's corner radius is 1, its half side 1/sqrt(2).
        square.scale.set((f.halfX + 0.7) * Math.SQRT2, (f.halfZ + 0.7) * Math.SQRT2, 1);
        square.visible = true;
      }
    }
    if (!occluding) s.mask.length = 0;

    // Fade the buildings that hide the selected agent, and bring them back when it is not.
    let root = s.buildings;
    if (root !== null && root.parent === null) {
      root = s.buildings = null;
      fader.dispose();
    }
    if (root === null) {
      const found = scene.getObjectByName("buildings");
      if (found !== undefined) {
        s.buildings = found;
        fader.bind(found);
      }
    }
    if (s.buildings !== null && fader.update(delta, wanted.current)) {
      let key = "";
      for (const a of AREAS)
        if (fader.opacityOf(a.id) < SOLID_ABOVE) key += `${key === "" ? "" : ","}${a.id}`;
      if (key !== s.fadedKey) {
        s.fadedKey = key;
        gl.domElement.dataset.fadedAreas = key;
      }
    }
  });

  return null;
}
