import { type Camera, type Intersection, type Object3D, Raycaster, Vector2 } from "three";
import { areaSelectionId } from "./selection.ts";

/** Building groups from M3.04 are named `building-<areaId>`; agent groups from M3.05 carry `userData.agentId`. */
const BUILDING_PREFIX = "building-";
const MAX_DEPTH = 4;

/** The selection id (agent id or `area:<id>`) of the thing `object` belongs to, or null. */
export function ownerOf(object: Object3D): string | null {
  let o: Object3D | null = object;
  while (o !== null) {
    const agentId = o.userData.agentId;
    if (typeof agentId === "string") return agentId;
    if (o.name.startsWith(BUILDING_PREFIX))
      return areaSelectionId(o.name.slice(BUILDING_PREFIX.length));
    o = o.parent;
  }
  return null;
}

/** Raycasting ignores `visible`, so a hit on a hidden object, or one under a hidden parent, is skipped. */
function isShown(object: Object3D): boolean {
  let o: Object3D | null = object;
  while (o !== null) {
    if (!o.visible) return false;
    o = o.parent;
  }
  return true;
}

function isPickableRoot(o: Object3D): boolean {
  return (
    typeof o.userData.agentId === "string" ||
    Array.isArray(o.userData.crewAgentIds) ||
    o.name.startsWith(BUILDING_PREFIX) ||
    o.userData.crewControl === true
  );
}

function controlOf(object: Object3D): Object3D | null {
  for (let o: Object3D | null = object; o !== null; o = o.parent) {
    if (o.userData.crewControl === true) return o;
  }
  return null;
}

function walk(o: Object3D, depth: number, out: Object3D[]): void {
  for (const child of o.children) {
    if (isPickableRoot(child)) out.push(child);
    else if (depth < MAX_DEPTH && child.children.length > 0 && !("isMesh" in child)) {
      walk(child, depth + 1, out);
    }
  }
}

/**
 * Fills `out` with the roots worth raycasting: agent groups and building groups. Windows,
 * scenery and the ground are skipped, so a pick tests a few dozen meshes rather than the scene.
 * Cheap enough to call once per pick; it only follows plain groups, a few levels deep.
 */
export function collectPickables(root: Object3D, out: Object3D[]): Object3D[] {
  out.length = 0;
  walk(root, 0, out);
  return out;
}

export interface Picker {
  /** Nonselecting control hit by the last pick. Shares the selection raycast. */
  readonly control: Object3D | null;
  /**
   * The selection id under normalized device coordinates (-1..1, y up), nearest first, or null.
   * `hidden` lets the caller look through things (faded buildings).
   */
  pick(
    ndcX: number,
    ndcY: number,
    camera: Camera,
    pickables: readonly Object3D[],
    hidden?: (id: string) => boolean,
  ): string | null;
}

/** A raycaster with reused scratch objects. Allocation per pick is limited to three.js's hit points. */
export function createPicker(): Picker {
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const hits: Intersection[] = [];
  const picker = {
    control: null as Object3D | null,
    pick(ndcX, ndcY, camera, pickables, hidden) {
      picker.control = null;
      ndc.set(ndcX, ndcY);
      raycaster.setFromCamera(ndc, camera);
      hits.length = 0;
      raycaster.intersectObjects(pickables as Object3D[], true, hits);
      let found: string | null = null;
      for (const hit of hits) {
        if (!isShown(hit.object)) continue;
        const control = controlOf(hit.object);
        if (control !== null) {
          picker.control = control;
          break;
        }
        const id = ownerOf(hit.object);
        if (id === null) continue;
        if (hidden?.(id)) continue;
        found = id;
        break;
      }
      hits.length = 0;
      return found;
    },
  } satisfies Picker;
  return picker;
}
