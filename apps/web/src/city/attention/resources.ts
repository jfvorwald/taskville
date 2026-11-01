import {
  BackSide,
  type BufferGeometry,
  CanvasTexture,
  DoubleSide,
  MeshBasicMaterial,
  RingGeometry,
  SpriteMaterial,
  SRGBColorSpace,
} from "three";
import type { Emote } from "./emote.ts";
import type { PulseHue } from "./pulse.ts";

// Pooled GPU resources for the stuck visuals. The pulse is drawn by swapping a mesh between a
// few shared materials of stepped opacity, so every agent, whatever its phase, shares them and
// nothing is allocated per frame. Hues are two shared constants: the theme contract has no
// attention tokens (and adding them is a contract change), so red and amber are the same in
// every theme, which also keeps them recognizable.

/** Number of opacity steps between the trough and the peak of the pulse. */
export const PULSE_STEPS = 12;
const MIN_OPACITY = 0.25;
const MAX_OPACITY = 0.95;

const HUES: Record<PulseHue, string> = { red: "#e5484d", amber: "#f5a524" };

// Indexed by hue and then step, so a frame looks a material up without building a key.
type Pool = Record<PulseHue, (MeshBasicMaterial | undefined)[]>;
const ringMaterials: Pool = { red: [], amber: [] };
const rimMaterials: Pool = { red: [], amber: [] };
let ring: BufferGeometry | undefined;

/** The step (0..PULSE_STEPS) for an intensity in 0..1. */
export function pulseStep(intensity: number): number {
  return Math.round(Math.min(1, Math.max(0, intensity)) * PULSE_STEPS);
}

function pooled(
  pool: Pool,
  hue: PulseHue,
  step: number,
  side: typeof BackSide | typeof DoubleSide,
): MeshBasicMaterial {
  const steps = pool[hue];
  let m = steps[step];
  if (m === undefined) {
    m = new MeshBasicMaterial({
      color: HUES[hue],
      side,
      transparent: true,
      opacity: MIN_OPACITY + (MAX_OPACITY - MIN_OPACITY) * (step / PULSE_STEPS),
      depthWrite: false,
    });
    steps[step] = m;
  }
  return m;
}

export function ringMaterial(hue: PulseHue, step: number): MeshBasicMaterial {
  return pooled(ringMaterials, hue, step, DoubleSide);
}

export function rimMaterial(hue: PulseHue, step: number): MeshBasicMaterial {
  return pooled(rimMaterials, hue, step, BackSide);
}

/** A flat ring on the ground around the feet, at full agent size. */
export function ringGeometry(): BufferGeometry {
  if (ring === undefined) {
    ring = new RingGeometry(0.42, 0.56, 32);
    ring.rotateX(-Math.PI / 2);
  }
  return ring;
}

const EMOTE_SIZE = 64;
const EMOTE_COLORS: Record<Emote, string> = {
  "!": "#ff5a5f",
  "?": "#f5a524",
  "...": "#e6e9ef",
  zzz: "#9ec5ff",
  sweat: "#7cc6ff",
};
const emoteMaterials = new Map<Emote, SpriteMaterial>();

function drawEmote(ctx: CanvasRenderingContext2D, emote: Emote): void {
  const c = EMOTE_SIZE / 2;
  ctx.clearRect(0, 0, EMOTE_SIZE, EMOTE_SIZE);
  ctx.fillStyle = "rgba(20, 24, 33, 0.78)";
  ctx.beginPath();
  ctx.arc(c, c, c - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = EMOTE_COLORS[emote];
  if (emote === "sweat") {
    ctx.beginPath();
    ctx.moveTo(c, 12);
    ctx.bezierCurveTo(c + 16, 30, c + 14, 50, c, 50);
    ctx.bezierCurveTo(c - 14, 50, c - 16, 30, c, 12);
    ctx.fill();
    return;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${emote === "zzz" ? 26 : 36}px system-ui, sans-serif`;
  ctx.fillText(emote, c, emote === "..." ? c - 6 : c + 1);
}

/** One shared sprite material per emote, drawn once on first use. */
export function emoteMaterial(emote: Emote): SpriteMaterial {
  let m = emoteMaterials.get(emote);
  if (m === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = EMOTE_SIZE;
    canvas.height = EMOTE_SIZE;
    const ctx = canvas.getContext("2d");
    if (ctx !== null) drawEmote(ctx, emote);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    m = new SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    emoteMaterials.set(emote, m);
  }
  return m;
}

/** Drops every pooled resource. For tests and a full scene teardown. */
export function disposeAttentionResources(): void {
  for (const pool of [ringMaterials, rimMaterials]) {
    for (const hue of ["red", "amber"] as const) {
      for (const m of pool[hue]) m?.dispose();
      pool[hue].length = 0;
    }
  }
  for (const m of emoteMaterials.values()) {
    m.map?.dispose();
    m.dispose();
  }
  emoteMaterials.clear();
  ring?.dispose();
  ring = undefined;
}
