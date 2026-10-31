import { OrthographicCamera } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useLayoutEffect, useRef } from "react";
import type { OrthographicCamera as OrthographicCameraImpl } from "three";
import { CITY_CAMERA, CITY_LAYOUT, cameraPosition, fitZoom } from "../layout/index.ts";

/**
 * The fixed isometric camera: orthographic, looking at the city center from the south-east,
 * zoomed to fit the whole ground slab in the canvas. It becomes the scene's default camera.
 */
export function CityCamera() {
  const size = useThree((s) => s.size);
  const ref = useRef<OrthographicCameraImpl>(null);
  const zoom = fitZoom({ width: size.width, height: size.height }, CITY_CAMERA, CITY_LAYOUT);
  const position = cameraPosition(CITY_CAMERA);
  useLayoutEffect(() => {
    const cam = ref.current;
    if (!cam) return;
    // Orientation is fixed; drei refreshes the projection when the zoom or canvas size changes.
    cam.lookAt(CITY_CAMERA.target.x, CITY_CAMERA.target.y, CITY_CAMERA.target.z);
  }, []);
  return (
    <OrthographicCamera
      ref={ref}
      makeDefault
      position={[position.x, position.y, position.z]}
      zoom={zoom}
      near={CITY_CAMERA.near}
      far={CITY_CAMERA.far}
    />
  );
}
