import { useEffect, useState } from "react";
import { CanvasTexture, SpriteMaterial, SRGBColorSpace } from "three";
import { readCssToken } from "../../themes/index.ts";

// The local fallback label until the world-labels slot (M3.03) takes over. Drawn as text onto a
// small canvas texture (never as markup), one texture and one material per agent, reused when the
// text changes and disposed on unmount.

const W = 256;
const H = 64;
/** World units per canvas pixel at full agent size. */
const UNIT = 0.0042;

export const LABEL_SIZE: readonly [number, number] = [W * UNIT, H * UNIT];

interface LabelGpu {
  canvas: HTMLCanvasElement;
  texture: CanvasTexture;
  material: SpriteMaterial;
}

function createGpu(): LabelGpu {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const material = new SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  return { canvas, texture, material };
}

function draw(gpu: LabelGpu, name: string, status: string): void {
  const ctx = gpu.canvas.getContext("2d");
  if (ctx === null) return;
  const font = readCssToken("--tv-font", "system-ui, sans-serif");
  ctx.clearRect(0, 0, W, H);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "#000";
  ctx.shadowBlur = 4;
  ctx.font = `600 24px ${font}`;
  ctx.fillStyle = readCssToken("--tv-text", "#d7dce5");
  ctx.fillText(name, W / 2, H * 0.32, W - 8);
  ctx.font = `20px ${font}`;
  ctx.fillStyle = readCssToken("--tv-text-muted", "#8b94a5");
  ctx.fillText(status, W / 2, H * 0.74, W - 8);
  gpu.texture.needsUpdate = true;
}

export interface LabelSpriteProps {
  name: string;
  status: string;
  /** Local height of the label origin above the feet. */
  y: number;
  /** Counter-scale so the label stays one size whatever the agent's size. */
  inverseScale: number;
}

export function LabelSprite({ name, status, y, inverseScale }: LabelSpriteProps) {
  const [gpu] = useState(createGpu);
  useEffect(() => {
    draw(gpu, name, status);
  }, [gpu, name, status]);
  useEffect(
    () => () => {
      gpu.texture.dispose();
      gpu.material.dispose();
    },
    [gpu],
  );
  return (
    <sprite
      material={gpu.material}
      position={[0, y, 0]}
      scale={[LABEL_SIZE[0] * inverseScale, LABEL_SIZE[1] * inverseScale, 1]}
      renderOrder={10}
    />
  );
}
