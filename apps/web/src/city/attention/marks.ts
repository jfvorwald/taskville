import { type Material, Mesh, type Object3D, Sprite, Vector3 } from "three";
import { LABEL_HEIGHT } from "../agents/labelEntries.ts";
import { sharedGeometries } from "../agents/resources.ts";
import { hullScale, type Size3 } from "../interaction/hull.ts";
import type { Emote } from "./emote.ts";
import type { PulseHue, PulseState } from "./pulse.ts";
import { emoteMaterial, pulseStep, rimMaterial, ringGeometry, ringMaterial } from "./resources.ts";

// The stuck visuals on one agent: a ground ring, a rim glow (an inverted hull over the torso
// and the head, the same technique as the hover glow) and an emote billboard. They are created the first
// time they are needed and then only shown, hidden and re-materialed, so a frame allocates
// nothing. Geometry and materials are shared (see resources.ts).

const RIM_THICKNESS = 0.03;
const RING_LIFT = 0.02;
// The world label's DOM anchor sits at LABEL_HEIGHT in the agent's local space and the label is
// drawn above it. The local fallback label (LabelSprite) is centred 0.1 higher and reaches down
// to about LABEL_HEIGHT - 0.034. The emote's top edge stops below both: centre + half the size.
const EMOTE_SIZE = 0.2;
const EMOTE_TOP = LABEL_HEIGHT - 0.05;
const EMOTE_Y = EMOTE_TOP - EMOTE_SIZE / 2;

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

  // What the ring and rims were last given, so a frame with the same look assigns nothing.
  let shownHue: PulseHue | null = null;
  let shownStep = -1;

  const buildRim = (material: Material): Mesh[] => {
    const out: Mesh[] = [];
    const bodies: Mesh[] = [];
    const { torso, head } = sharedGeometries();
    root.updateWorldMatrix(true, true);
    root.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh !== true || o.userData.isHull === true) return;
      if (m.geometry === torso || m.geometry === head) bodies.push(m);
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
      const hull = decoration(new Mesh(g, material));
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
        rims ??= buildRim(rimMaterial(hue, step));
        if (hue !== shownHue || step !== shownStep) {
          shownHue = hue;
          shownStep = step;
          ring.material = ringMaterial(hue, step);
          const rim = rimMaterial(hue, step);
          for (const hull of rims) hull.material = rim;
        }
        ring.visible = true;
        for (const hull of rims) hull.visible = true;
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
      shownHue = null;
      shownStep = -1;
    },
  };
}
