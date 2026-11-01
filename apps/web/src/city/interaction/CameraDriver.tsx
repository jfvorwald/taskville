import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import type { OrthographicCamera } from "three";
import { CITY_CAMERA, CITY_LAYOUT, fitZoom } from "../layout/index.ts";
import { createCameraPose } from "./cameraPose.ts";
import { type CameraRig, cameraRig } from "./cameraRig.ts";

const EPSILON = 1e-6;

/**
 * Applies the user's camera adjustment (`cameraRig`) on top of M3.04's `CityCamera`: a turn about
 * the vertical axis through the city center, and a zoom factor. The default pose is whatever the
 * camera has when the turn is zero (it is read, not recomputed), so Reset restores exactly what
 * was on screen before. With the default view it writes nothing; otherwise it compares before
 * writing, so a still camera costs a few number comparisons per frame and no allocation.
 * Renders nothing.
 */
export function CameraDriver({ rig = cameraRig }: { rig?: CameraRig }) {
  const view = useRef(rig.getSnapshot());
  const fit = useRef({ width: -1, height: -1, zoom: 1 });
  const pose = useRef(createCameraPose());
  useEffect(() => {
    view.current = rig.getSnapshot();
    return rig.subscribe(() => {
      view.current = rig.getSnapshot();
    });
  }, [rig]);

  useFrame(({ camera, size }) => {
    if ((camera as OrthographicCamera).isOrthographicCamera !== true) return;
    const cam = camera as OrthographicCamera;
    const f = fit.current;
    if (f.width !== size.width || f.height !== size.height) {
      f.width = size.width;
      f.height = size.height;
      f.zoom = fitZoom({ width: size.width, height: size.height }, CITY_CAMERA, CITY_LAYOUT);
    }
    const v = view.current;

    const zoom = f.zoom * v.zoom;
    if (Math.abs(cam.zoom - zoom) > EPSILON) {
      cam.zoom = zoom;
      cam.updateProjectionMatrix();
    }

    pose.current.apply(cam, v.azimuthOffset);
  });
  return null;
}
