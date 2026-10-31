import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { type OrthographicCamera, Quaternion, Vector3 } from "three";
import { CITY_CAMERA, CITY_LAYOUT, fitZoom } from "../layout/index.ts";
import { type CameraRig, cameraRig } from "./cameraRig.ts";

const rad = (deg: number) => (deg * Math.PI) / 180;
const EPSILON = 1e-6;
const UP = new Vector3(0, 1, 0);

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
  const base = useRef({
    x: 0,
    y: 0,
    z: 0,
    q: new Quaternion(),
    turn: new Quaternion(),
    turned: false,
  });
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

    const b = base.current;
    if (v.azimuthOffset === 0) {
      // Default pose: follow whatever the camera is, and put it back if we had turned it.
      if (b.turned) {
        cam.position.set(b.x, b.y, b.z);
        cam.quaternion.copy(b.q);
        b.turned = false;
      }
      b.x = cam.position.x;
      b.y = cam.position.y;
      b.z = cam.position.z;
      b.q.copy(cam.quaternion);
      return;
    }
    const a = rad(v.azimuthOffset);
    const sin = Math.sin(a);
    const cos = Math.cos(a);
    cam.position.set(b.x * cos + b.z * sin, b.y, -b.x * sin + b.z * cos);
    b.turn.setFromAxisAngle(UP, a);
    cam.quaternion.copy(b.turn).multiply(b.q);
    b.turned = true;
  });
  return null;
}
