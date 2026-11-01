import { Canvas } from "@react-three/fiber";
import { CityRoot } from "./city/index.tsx";
import { RenderPacer } from "./city/runtime/index.ts";
import { AnchorBridge, worldAnchors } from "./overlays/host/index.ts";
import { OverlayRoot } from "./overlays/index.tsx";
import styles from "./SceneRoot.module.css";
import { readCssToken } from "./themes/index.ts";

/**
 * The paired app: a WebGL canvas with the DOM overlay layer on top. Later tickets mount into
 * `CityRoot` (3D) and `OverlayRoot` (DOM); this file should not need to change.
 */
export function SceneRoot() {
  return (
    <div className={styles.root} data-testid="scene-root">
      <Canvas
        camera={{ position: [16, 14, 16], fov: 45 }}
        dpr={[1, 2]}
        frameloop="demand"
        onCreated={({ camera }) => camera.lookAt(0, 0, 0)}
      >
        <color attach="background" args={[readCssToken("--tv-scene-bg", "#11141a")]} />
        <AnchorBridge source={worldAnchors} />
        <CityRoot />
        <RenderPacer />
      </Canvas>
      <OverlayRoot />
    </div>
  );
}
