import { Canvas, type RootState } from "@react-three/fiber";
import type { Material, Mesh, Object3D, Sprite } from "three";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { AgentsLayer } from "../agents/AgentsLayer.tsx";
import { sharedGeometries } from "../agents/resources.ts";
import type { AgentView } from "../agents/types.ts";
import { ringMaterial } from "./resources.ts";

// The stuck visuals' lifecycle on a live agent (M4.05 review fixes): the ring and rim show for
// needs-you, hide when the attention clears or turns to waiting, change hue from red to amber on
// trouble, come back on the same objects, and are taken off the agent when it unmounts. The rim
// covers the torso and head only. An unparseable `since` gives a steady ring, not a frozen trough.

const FRAME_WAIT = { timeout: 10_000 };
const ID = "a1";

const RED = ringMaterial("red", 0).color.getHex();
const AMBER = ringMaterial("amber", 0).color.getHex();

type Attn = AgentView["attention"];

function view(attention: Attn): AgentView {
  return {
    id: ID,
    kind: "session",
    activity: "idle",
    placement: { x: 0, y: 0, z: 0, heading: 0 },
    ...(attention === undefined ? {} : { attention }),
  };
}

let root: RootState | undefined;

function Stage({ agents, reducedMotion }: { agents: AgentView[]; reducedMotion: boolean }) {
  return (
    <div style={{ width: 240, height: 180 }}>
      <Canvas
        camera={{ position: [0, 1.5, 3], fov: 40 }}
        onCreated={(s) => {
          root = s;
        }}
      >
        <AgentsLayer agents={agents} reducedMotion={reducedMotion} onLabels={() => {}} />
      </Canvas>
    </div>
  );
}

async function mount(attention: Attn, reducedMotion: boolean) {
  root = undefined;
  const screen = await render(<Stage agents={[view(attention)]} reducedMotion={reducedMotion} />);
  await vi.waitFor(() => expect(agentGroup()).toBeDefined(), FRAME_WAIT);
  return {
    set: (next: Attn) =>
      screen.rerender(<Stage agents={[view(next)]} reducedMotion={reducedMotion} />),
    remove: () => screen.rerender(<Stage agents={[]} reducedMotion={reducedMotion} />),
    unmount: () => screen.unmount(),
  };
}

function agentGroup(): Object3D | undefined {
  return root?.scene.children.find((o) => o.userData.agentId === ID);
}

/** Waits until `n` more frames were drawn, so the per-frame marks update has run on new props. */
async function frames(n: number): Promise<void> {
  const target = (root?.gl.info.render.frame ?? 0) + n;
  await vi.waitFor(() => expect(root?.gl.info.render.frame).toBeGreaterThanOrEqual(target), {
    timeout: 10_000,
  });
}

function ringOf(g: Object3D | undefined): Mesh | undefined {
  return g?.children.find(
    (c): c is Mesh => c.userData.isHull === true && (c as Mesh).geometry?.type === "RingGeometry",
  );
}

/** The rim hulls: decoration meshes that sit on a body mesh. */
function rimsOf(g: Object3D | undefined): Mesh[] {
  const out: Mesh[] = [];
  g?.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh === true && o.userData.isHull === true && (o.parent as Mesh).isMesh === true) {
      out.push(m);
    }
  });
  return out;
}

function emoteOf(g: Object3D | undefined): Sprite | undefined {
  return g?.children.find((c): c is Sprite => c.type === "Sprite" && c.userData.isHull === true);
}

const hex = (m: Mesh): number =>
  (m.material as Material & { color: { getHex(): number } }).color.getHex();

describe("attention marks on a live agent", () => {
  it("shows for needs-you, hides when the attention clears or turns to waiting, and reuses its objects", async () => {
    const stage = await mount({ level: "needs_you", kind: "permission", sinceMs: 0 }, true);
    await vi.waitFor(() => expect(ringOf(agentGroup())).toBeDefined(), FRAME_WAIT);
    await frames(2);
    const ring = ringOf(agentGroup()) as Mesh;
    const rims = rimsOf(agentGroup());
    expect(ring.visible).toBe(true);
    expect(rims.length).toBeGreaterThan(0);
    expect(rims.every((r) => r.visible)).toBe(true);

    await stage.set({ level: "waiting", kind: "turn_ended", sinceMs: 0 });
    await frames(3);
    expect(ring.visible).toBe(false);
    expect(rims.every((r) => !r.visible)).toBe(true);

    await stage.set({ level: "needs_you", kind: "permission", sinceMs: 0 });
    await frames(3);
    expect(ring.visible).toBe(true);
    expect(rims.every((r) => r.visible)).toBe(true);
    // Shown again on the very same objects: nothing is rebuilt.
    expect(ringOf(agentGroup())).toBe(ring);
    expect(rimsOf(agentGroup())).toEqual(rims);

    await stage.set(undefined);
    await frames(3);
    expect(ring.visible).toBe(false);
    expect(rims.every((r) => !r.visible)).toBe(true);
    await stage.unmount();
  }, 30_000);

  it("turns from red to amber when needs-you becomes trouble", async () => {
    const stage = await mount({ level: "needs_you", kind: "permission", sinceMs: 0 }, true);
    await vi.waitFor(() => expect(ringOf(agentGroup())).toBeDefined(), FRAME_WAIT);
    await frames(2);
    const ring = ringOf(agentGroup()) as Mesh;
    const rims = rimsOf(agentGroup());
    expect(hex(ring)).toBe(RED);
    expect(rims.every((r) => hex(r) === RED)).toBe(true);

    await stage.set({ level: "trouble", kind: "silent", sinceMs: 0 });
    await frames(3);
    expect(ring.visible).toBe(true);
    expect(hex(ring)).toBe(AMBER);
    expect(rims.every((r) => r.visible && hex(r) === AMBER)).toBe(true);
    await stage.unmount();
  }, 30_000);

  it("takes the ring, rims and emote off the agent when it unmounts", async () => {
    const stage = await mount({ level: "needs_you", kind: "permission", sinceMs: 0 }, true);
    await vi.waitFor(() => expect(ringOf(agentGroup())).toBeDefined(), FRAME_WAIT);
    await frames(2);
    const group = agentGroup() as Object3D;
    const ring = ringOf(group) as Mesh;
    const rims = rimsOf(group);
    const emote = emoteOf(group) as Sprite;
    expect(emote).toBeDefined();
    expect(rims.length).toBeGreaterThan(0);

    await stage.remove();
    await vi.waitFor(() => expect(agentGroup()).toBeUndefined(), FRAME_WAIT);
    expect(ring.parent).toBeNull();
    expect(emote.parent).toBeNull();
    for (const r of rims) expect(r.parent).toBeNull();
  }, 30_000);

  it("puts the rim on the torso and the head only", async () => {
    const stage = await mount({ level: "needs_you", kind: "permission", sinceMs: 0 }, true);
    await vi.waitFor(() => expect(ringOf(agentGroup())).toBeDefined(), FRAME_WAIT);
    await frames(2);
    const rims = rimsOf(agentGroup());
    const geo = sharedGeometries();
    expect(rims).toHaveLength(2);
    expect(new Set(rims.map((r) => (r.parent as Mesh).geometry))).toEqual(
      new Set([geo.torso, geo.head]),
    );
    await stage.unmount();
  }, 30_000);

  it("keeps a steady, visible ring for needs-you when since does not parse", async () => {
    // No `sinceMs`, motion allowed: the pulse must not freeze at its trough.
    const stage = await mount({ level: "needs_you", kind: "permission" }, false);
    await vi.waitFor(() => expect(ringOf(agentGroup())).toBeDefined(), FRAME_WAIT);
    await frames(2);
    const ring = ringOf(agentGroup()) as Mesh;
    const trough = ringMaterial("red", 0).opacity;
    const samples: number[] = [];
    for (let i = 0; i < 4; i++) {
      samples.push((ring.material as Material).opacity);
      await frames(8);
    }
    expect(ring.visible).toBe(true);
    expect(new Set(samples).size).toBe(1);
    expect(samples[0]).toBeGreaterThan(trough);
    await stage.unmount();
  }, 30_000);
});
