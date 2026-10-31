import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import { Matrix4 } from "three";
import type { AnchorSource } from "./types.ts";

/**
 * Lives inside the `<Canvas>`: publishes the camera's view-projection matrix and the canvas size
 * to the anchor source every frame, so DOM overlays can follow world points. Renders nothing.
 * The source ignores frames where nothing moved, so a still camera costs no React work.
 */
export function AnchorBridge({ source }: { source: AnchorSource }) {
  const matrix = useMemo(() => new Matrix4(), []);
  useFrame(({ camera, size }) => {
    camera.updateMatrixWorld();
    matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    source.setProjection(matrix.elements, { width: size.width, height: size.height });
  });
  return null;
}
