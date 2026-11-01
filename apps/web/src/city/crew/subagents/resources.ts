import {
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  MeshStandardMaterial,
  SpriteMaterial,
  SRGBColorSpace,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { colorMaterial, sharedGeometries } from "../../agents/resources.ts";

// Pooled GPU resources for the crew. A subagent bot is the block agent's own parts merged into one
// body mesh and one trim mesh (two draw calls where a full block agent takes nine), and a fade is
// a few stepped-opacity materials shared by every bot, so nothing is allocated per frame.

/** Number of opacity steps between invisible and opaque. */
export const FADE_STEPS = 8;

interface CrewGeometries {
  /** Legs, torso, head and arms in one geometry, in the block agent's coordinates. */
  body: BufferGeometry;
  /** The scarf: the parent's trim color. */
  trim: BufferGeometry;
  /** The result cube a returning bot carries. */
  cube: BufferGeometry;
}

let geometries: CrewGeometries | undefined;
const fadeMaterials = new Map<string, MeshStandardMaterial>();
const labelMaterials = new Map<string, SpriteMaterial>();

function placed(source: BufferGeometry, x: number, y: number, z: number): BufferGeometry {
  return source.clone().translate(x, y, z);
}

export function crewGeometries(): CrewGeometries {
  if (geometries === undefined) {
    const geo = sharedGeometries();
    const parts = [
      placed(geo.leg, -0.1, 0.175, 0),
      placed(geo.leg, 0.1, 0.175, 0),
      placed(geo.torso, 0, 0.55, 0),
      placed(geo.head, 0, 0.94, 0),
      placed(geo.limb, -0.24, 0.55, 0),
      placed(geo.limb, 0.24, 0.55, 0),
    ];
    const body = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    geometries = {
      body,
      trim: placed(geo.scarf, 0, 0.78, 0),
      cube: new BoxGeometry(0.18, 0.18, 0.18),
    };
  }
  return geometries;
}

/** The bot's material at `opacity`: the shared opaque one when solid, a stepped one while fading. */
export function crewMaterial(hex: string, opacity: number): MeshStandardMaterial {
  const step = Math.round(Math.min(1, Math.max(0, opacity)) * FADE_STEPS);
  if (step >= FADE_STEPS) return colorMaterial(hex);
  const key = `${hex}:${step}`;
  let m = fadeMaterials.get(key);
  if (m === undefined) {
    m = new MeshStandardMaterial({
      color: hex,
      roughness: 0.8,
      metalness: 0,
      transparent: true,
      opacity: step / FADE_STEPS,
      depthWrite: false,
    });
    fadeMaterials.set(key, m);
  }
  return m;
}

const W = 192;
const H = 64;

/**
 * A small dark pill with `text` on it, one shared material per distinct text and fill. `fill`
 * (a `#rrggbb`) paints the pill that color instead, for a pill that carries an attention signal.
 */
export function pillMaterial(text: string, fill?: string): SpriteMaterial {
  const key = fill === undefined ? text : `${fill}|${text}`;
  let m = labelMaterials.get(key);
  if (m === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (ctx !== null) {
      ctx.fillStyle = fill ?? "rgba(20, 24, 33, 0.82)";
      ctx.beginPath();
      ctx.roundRect(2, 2, W - 4, H - 4, H / 2 - 2);
      ctx.fill();
      ctx.fillStyle = fill === undefined ? "#e6e9ef" : "#141821";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "700 30px system-ui, sans-serif";
      ctx.fillText(text, W / 2, H / 2 + 1, W - 24);
    }
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    m = new SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    labelMaterials.set(key, m);
  }
  return m;
}

/** World size of a pill sprite. */
export const PILL_SIZE: readonly [number, number] = [0.6, 0.2];

/** Drops every pooled resource. For tests and a full scene teardown. */
export function disposeCrewResources(): void {
  if (geometries !== undefined) {
    for (const g of Object.values(geometries)) g.dispose();
    geometries = undefined;
  }
  for (const m of fadeMaterials.values()) m.dispose();
  fadeMaterials.clear();
  for (const m of labelMaterials.values()) {
    m.map?.dispose();
    m.dispose();
  }
  labelMaterials.clear();
}
