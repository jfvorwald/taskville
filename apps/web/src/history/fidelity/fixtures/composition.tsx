import { Canvas } from "@react-three/fiber";
import { useSyncExternalStore } from "react";
import type { Scene } from "three";
import { expect } from "vitest";
import { page } from "vitest/browser";
import { CityRoot } from "../../../city/index.tsx";
import { HistoryControls } from "../../ui/HistoryControls.tsx";
import { useHistoryPresentation } from "../../ui/HistoryProvider.tsx";

/** The production SceneRoot city seam, with read-only scene and position observations. */
export function CityComposition({ onScene }: { onScene(scene: Scene): void }) {
  const { store, mode, time, rate } = useHistoryPresentation();
  const view = useSyncExternalStore(store.subscribe, store.getState);
  return (
    <>
      <output aria-label="Fidelity position">{`${mode}:${view.state?.head ?? 0}:${rate}`}</output>
      <div style={{ width: 400, height: 300 }}>
        <Canvas camera={{ position: [16, 14, 16], fov: 45 }} onCreated={(s) => onScene(s.scene)}>
          <CityRoot store={store} mode={mode} historyTime={time} />
        </Canvas>
      </div>
      <HistoryControls />
    </>
  );
}

export async function position(head: number, rate = 1, mode = "history") {
  await expect
    .element(page.getByRole("status", { name: "Fidelity position" }))
    .toHaveTextContent(`${mode}:${head}:${rate}`);
}
