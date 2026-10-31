import { describe, expect, it } from "vitest";
import { projectToViewport, type Viewport } from "../../../src/overlays/host/projection.ts";

type Mat4 = number[]; // column-major, as three.js Matrix4.elements

function mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++)
        out[col * 4 + row] += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
  return out;
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function translate(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

/** Right-handed perspective camera looking down -z, as three.js builds it. */
function perspective(fovDeg: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const nf = 1 / (near - far);
  return [
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) * nf,
    -1,
    0,
    0,
    2 * far * near * nf,
    0,
  ];
}

const VIEWPORT: Viewport = { width: 200, height: 100 };

describe("projectToViewport: identity (normalized device coordinates)", () => {
  it("maps ndc (0,0) to the centre and flips y so +y is up the screen", () => {
    const p = projectToViewport([0, 0, 0], IDENTITY, VIEWPORT);
    expect(p).toMatchObject({ x: 100, y: 50, visible: true });
    expect(projectToViewport([1, 1, 0], IDENTITY, VIEWPORT)).toMatchObject({ x: 200, y: 0 });
    expect(projectToViewport([-1, -1, 0], IDENTITY, VIEWPORT)).toMatchObject({ x: 0, y: 100 });
  });

  it("scales with the viewport", () => {
    const p = projectToViewport([0.5, -0.5, 0], IDENTITY, { width: 400, height: 200 });
    expect(p.x).toBeCloseTo(300);
    expect(p.y).toBeCloseTo(150);
  });
});

describe("projectToViewport: perspective camera 10 units back", () => {
  const view = translate(0, 0, -10);
  const proj = perspective(90, 2, 0.1, 100);
  const vp = mul(proj, view);

  it("puts the origin in the centre of the screen", () => {
    const p = projectToViewport([0, 0, 0], vp, VIEWPORT);
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(50);
    expect(p.visible).toBe(true);
  });

  it("moves right and up for points right of and above the origin", () => {
    // fov 90 and aspect 2: ndcX = x / (aspect * depth) = 5 / 20, ndcY = y / depth = 5 / 10
    const p = projectToViewport([5, 5, 0], vp, VIEWPORT);
    expect(p.x).toBeCloseTo((0.25 * 0.5 + 0.5) * 200);
    expect(p.y).toBeCloseTo((1 - (0.5 * 0.5 + 0.5)) * 100);
  });

  it("makes nearer points move further from the centre than farther ones", () => {
    const near = projectToViewport([2, 0, 5], vp, VIEWPORT);
    const far = projectToViewport([2, 0, -5], vp, VIEWPORT);
    expect(near.x - 100).toBeGreaterThan(far.x - 100);
  });

  it("hides a point behind the camera even though the divide would mirror it into view", () => {
    const p = projectToViewport([0, 0, 20], vp, VIEWPORT);
    expect(p.visible).toBe(false);
  });

  it("hides a point beyond the far plane and one nearer than the near plane", () => {
    expect(projectToViewport([0, 0, -200], vp, VIEWPORT).visible).toBe(false);
    expect(projectToViewport([0, 0, 9.95], vp, VIEWPORT).visible).toBe(false);
  });

  it("hides points outside the viewport, honouring a margin", () => {
    // ndcX = 15 / 20 = 0.75 is inside; 45 / 20 = 2.25 is far outside.
    expect(projectToViewport([15, 0, 0], vp, VIEWPORT).visible).toBe(true);
    const out = projectToViewport([45, 0, 0], vp, VIEWPORT);
    expect(out.visible).toBe(false);
    expect(projectToViewport([45, 0, 0], vp, VIEWPORT, { margin: 400 }).visible).toBe(true);
  });
});

describe("projectToViewport: degenerate input", () => {
  it("reports not visible for a zero-size viewport or a zero w", () => {
    expect(projectToViewport([0, 0, 0], IDENTITY, { width: 0, height: 0 }).visible).toBe(false);
    const zeroW = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
    expect(projectToViewport([0, 0, 0], zeroW, VIEWPORT).visible).toBe(false);
  });
});
