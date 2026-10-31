import {
  type InstancedMesh,
  type Material,
  Matrix4,
  type Mesh,
  type Object3D,
  Object3D as Scratch,
} from "three";
import type { WindowSite } from "../buildings/parts.ts";
import { stepFade } from "./occlusion.ts";

export interface BuildingFaderOptions {
  /** Every window site in the order the instanced mesh was filled (`windowSites(layout)`). */
  sites: readonly WindowSite[];
  /** Opacity of a fully faded building. */
  fadedOpacity?: number;
  /** Seconds to go from solid to fully faded, and back. */
  seconds?: number;
}

export interface BuildingFader {
  /** Finds the `building-<id>` groups and the windows mesh under `root` (the city's "buildings" group). */
  bind(root: Object3D): void;
  /**
   * Eases every building toward faded (when `wanted(areaId)`) or solid. Returns true when any
   * opacity moved this call, so a caller can skip further work on a still scene.
   */
  update(dt: number, wanted: (areaId: string) => boolean): boolean;
  /** Current opacity of a building, 1 when not bound. */
  opacityOf(areaId: string): number;
  dispose(): void;
}

interface BuildingState {
  id: string;
  meshes: Mesh[];
  originals: Material[];
  clones: Material[] | null;
  opacity: number;
  swapped: boolean;
  windows: number[];
  windowsHidden: boolean;
}

const HIDE_WINDOWS_BELOW = 0.6;
const PREFIX = "building-";
const scratch = new Scratch();
const zero = new Matrix4().makeScale(0, 0, 0);

function cloneForFade(m: Material): Material {
  const c = m.clone();
  c.transparent = true;
  c.depthWrite = false;
  return c;
}

/**
 * Fades whole buildings without touching M3.04's code. Their meshes share one material per tone,
 * so a faded building gets its own clones (made once, on first fade) swapped in while it is
 * see-through, and the shared material is put back once it is solid again. The instanced windows
 * cannot be faded per building, so a faded building's window instances are scaled to nothing.
 */
export function createBuildingFader(options: BuildingFaderOptions): BuildingFader {
  const faded = options.fadedOpacity ?? 0.18;
  const seconds = options.seconds ?? 0.25;
  const states = new Map<string, BuildingState>();
  let windowsMesh: InstancedMesh | null = null;

  const writeWindows = (state: BuildingState, hidden: boolean) => {
    const mesh = windowsMesh;
    if (mesh === null) return;
    for (const i of state.windows) {
      if (hidden) {
        mesh.setMatrixAt(i, zero);
      } else {
        const s = options.sites[i];
        if (s === undefined) continue;
        scratch.position.set(s.x, s.y, s.z);
        scratch.rotation.set(0, s.yaw, 0);
        scratch.scale.set(1, 1, 1);
        scratch.updateMatrix();
        mesh.setMatrixAt(i, scratch.matrix);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    state.windowsHidden = hidden;
  };

  const swapIn = (state: BuildingState) => {
    // The shared materials can have been replaced since `bind` (a theme change), so read them now.
    const live = state.meshes.map((m) => m.material as Material);
    if (state.clones === null || live.some((m, i) => m !== state.originals[i])) {
      for (const c of state.clones ?? []) c.dispose();
      state.originals = live;
      state.clones = live.map(cloneForFade);
    }
    state.meshes.forEach((m, i) => {
      const c = state.clones?.[i];
      if (c) m.material = c;
    });
    state.swapped = true;
  };

  const swapOut = (state: BuildingState) => {
    state.meshes.forEach((m, i) => {
      const o = state.originals[i];
      if (o) m.material = o;
    });
    state.swapped = false;
  };

  return {
    bind(root) {
      states.clear();
      windowsMesh = null;
      root.traverse((o) => {
        if ((o as InstancedMesh).isInstancedMesh === true && windowsMesh === null) {
          if ((o as InstancedMesh).count === options.sites.length) windowsMesh = o as InstancedMesh;
        }
        if (!o.name.startsWith(PREFIX)) return;
        const id = o.name.slice(PREFIX.length);
        const meshes: Mesh[] = [];
        o.traverse((c) => {
          if ((c as Mesh).isMesh === true) meshes.push(c as Mesh);
        });
        const windows: number[] = [];
        options.sites.forEach((s, i) => {
          if (s.areaId === id) windows.push(i);
        });
        states.set(id, {
          id,
          meshes,
          originals: meshes.map((m) => m.material as Material),
          clones: null,
          opacity: 1,
          swapped: false,
          windows,
          windowsHidden: false,
        });
      });
    },
    update(dt, wanted) {
      let changed = false;
      for (const state of states.values()) {
        const target = wanted(state.id) ? faded : 1;
        if (state.opacity === target && state.swapped === target < 1) continue;
        const next = stepFade(state.opacity, target, dt, seconds / (1 - faded));
        if (next !== state.opacity) changed = true;
        state.opacity = next;
        if (next < 1 && !state.swapped) swapIn(state);
        if (state.swapped) {
          for (const c of state.clones ?? []) c.opacity = next;
        }
        if (next >= 1 && state.swapped) swapOut(state);
        const hide = next < HIDE_WINDOWS_BELOW;
        if (hide !== state.windowsHidden) writeWindows(state, hide);
      }
      return changed;
    },
    opacityOf: (areaId) => states.get(areaId)?.opacity ?? 1,
    dispose() {
      for (const state of states.values()) {
        if (state.swapped) swapOut(state);
        for (const c of state.clones ?? []) c.dispose();
        if (state.windowsHidden) writeWindows(state, false);
      }
      states.clear();
    },
  };
}
