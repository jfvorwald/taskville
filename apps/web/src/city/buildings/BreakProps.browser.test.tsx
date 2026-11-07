import { Canvas, type RootState } from "@react-three/fiber";
import type { Group, InstancedMesh, MeshBasicMaterial } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { cityPaletteFromTokens, resolveTokens } from "../../themes/core/contract.ts";
import { THEMES } from "../../themes/core/themes.ts";
import { CITY_LAYOUT } from "../layout/index.ts";
import { CityScene } from "./CityScene.tsx";
import type { CityPalette } from "./palette.ts";

// M9.02: the bar and smoke corner props render instanced in every theme. Assumed API: CityScene
// draws a group named "break-props" holding InstancedMesh children, colored by the palette keys
// barCounter, barStool and smokeBench.

let state: RootState | undefined;
afterEach(() => {
  state = undefined;
  vi.restoreAllMocks();
});

function Scene({ palette }: { palette: CityPalette }) {
  return (
    <div style={{ width: 320, height: 240 }}>
      <Canvas
        onCreated={(s) => {
          state = s;
        }}
      >
        <CityScene palette={palette} />
      </Canvas>
    </div>
  );
}

function breakMeshes(): InstancedMesh[] {
  const group = state?.scene.getObjectByName("break-props") as Group | undefined;
  if (!group) throw new Error("no break-props group in the scene");
  return group.children.filter((c) => (c as InstancedMesh).isInstancedMesh) as InstancedMesh[];
}

describe("break props", () => {
  for (const theme of THEMES) {
    it(`renders the bar and smoke corner props in ${theme.id} without errors`, async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const palette = cityPaletteFromTokens(resolveTokens(theme, "day"));
      await render(<Scene palette={palette} />);
      await vi.waitFor(() => expect(state).toBeDefined());
      await new Promise((r) => setTimeout(r, 200)); // let a few frames render

      const meshes = breakMeshes();
      const propCount = CITY_LAYOUT.breakSites.reduce((n, s) => n + s.props.length, 0);
      expect(propCount).toBeGreaterThan(0);
      for (const m of meshes) expect(m.count).toBeGreaterThan(0);
      expect(meshes.reduce((n, m) => n + m.count, 0)).toBeGreaterThanOrEqual(propCount);

      const colors = new Set(
        meshes.map((m) => (m.material as MeshBasicMaterial).color.getHexString()),
      );
      const p = palette as unknown as Record<string, string>;
      for (const key of ["barCounter", "barStool", "smokeBench"]) {
        expect(colors, `${theme.id} ${key}`).toContain((p[key] ?? "").slice(1).toLowerCase());
      }
      expect(errors).not.toHaveBeenCalled();
    });
  }
});
