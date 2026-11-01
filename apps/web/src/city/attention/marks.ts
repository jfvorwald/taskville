import { Mesh, type Object3D, Sprite, Vector3 } from "three";
import { hullScale, type Size3 } from "../interaction/hull.ts";
import type { Emote } from "./emote.ts";
import type { PulseState } from "./pulse.ts";
import { emoteMaterial, pulseStep, rimMaterial, ringGeometry, ringMaterial } from "./resources.ts";

// The stuck visuals on one agent: a ground ring, a rim glow (an inverted hull over each body
// mesh, the same technique as the hover glow) and an emote billboard. They are created the first
// time they are needed and then only shown, hidden and re-materialed, so a frame allocates
// nothing. Geometry and materials are shared (see resources.ts).

const RIM_THICKNESS = 0.03;
const RING_LIFT = 0.02;
const EMOTE_Y = 1.3;
const EMOTE_SIZE = 0.3;

export interface AttentionMarks {
  update(pulse: PulseState, emote: Emote | null): void;
  /** Removes the marks from the agent; shared resources stay pooled. */
  dispose(): void;
}

const worldScale = new Vector3();
const scaleOut: Size3 = { x: 1, y: 1, z: 1 };
const sizeOut: Size3 = { x: 1, y: 1, z: 1 };

function noRaycast(): void {}

/** Marks `o` as decoration: the hover glow skips it and picking passes through it. */
function decoration<T extends Object3D>(o: T): T {
  o.userData.isHull = true;
  o.raycast = noRaycast;
  return o;
}

export function createAttentionMarks(root: Object3D): AttentionMarks {
  let ring: Mesh | undefined;
  let rims: Mesh[] | undefined;
  let sprite: Sprite | undefined;

  const buildRim = (): Mesh[] => {
    const out: Mesh[] = [];
    const bodies: Mesh[] = [];
    root.updateWorldMatrix(true, true);
    root.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh === true && o.userData.isHull !== true) bodies.push(m);
    });
    for (const body of bodies) {
      const g = body.geometry;
      if (g.boundingBox === null) g.computeBoundingBox();
      const b = g.boundingBox;
      sizeOut.x = b ? b.max.x - b.min.x : 1;
      sizeOut.y = b ? b.max.y - b.min.y : 1;
      sizeOut.z = b ? b.max.z - b.min.z : 1;
      body.getWorldScale(worldScale);
      hullScale(sizeOut, worldScale, RIM_THICKNESS, scaleOut);
      const hull = decoration(new Mesh(g, rimMaterial("red", 0)));
      hull.scale.set(scaleOut.x, scaleOut.y, scaleOut.z);
      body.add(hull);
      out.push(hull);
    }
    return out;
  };

  return {
    update(pulse, emote) {
      const hue = pulse.hue;
      const glowing = pulse.ring && hue !== null;
      if (glowing) {
        const step = pulseStep(pulse.intensity);
        if (ring === undefined) {
          ring = decoration(new Mesh(ringGeometry(), ringMaterial(hue, step)));
          ring.position.y = RING_LIFT;
          ring.renderOrder = 5;
          root.add(ring);
        }
        rims ??= buildRim();
        ring.material = ringMaterial(hue, step);
        ring.visible = true;
        const rim = rimMaterial(hue, step);
        for (const hull of rims) {
          hull.material = rim;
          hull.visible = true;
        }
      } else {
        if (ring !== undefined) ring.visible = false;
        if (rims !== undefined) for (const hull of rims) hull.visible = false;
      }

      if (emote !== null) {
        if (sprite === undefined) {
          sprite = decoration(new Sprite(emoteMaterial(emote)));
          sprite.scale.set(EMOTE_SIZE, EMOTE_SIZE, 1);
          sprite.position.y = EMOTE_Y;
          sprite.renderOrder = 11;
          root.add(sprite);
        }
        sprite.material = emoteMaterial(emote);
        sprite.visible = true;
      } else if (sprite !== undefined) {
        sprite.visible = false;
      }
    },
    dispose() {
      ring?.removeFromParent();
      if (rims !== undefined) for (const hull of rims) hull.removeFromParent();
      sprite?.removeFromParent();
      ring = undefined;
      rims = undefined;
      sprite = undefined;
    },
  };
}
