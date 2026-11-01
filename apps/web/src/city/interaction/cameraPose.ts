import { type OrthographicCamera, Quaternion, Vector3 } from "three";

const UP = new Vector3(0, 1, 0);
const rad = (deg: number) => (deg * Math.PI) / 180;

export interface CameraPose {
  /**
   * Puts the camera at its default pose turned by `azimuthOffset` degrees about the vertical axis
   * through the city center. The default pose is the one the camera has when this is first called
   * and whenever the offset is zero (it is read, not recomputed); a turned pose is always computed
   * from it, so repeated calls do not accumulate.
   */
  apply(camera: OrthographicCamera, azimuthOffset: number): void;
}

/** One tracker per camera: a fresh camera needs a fresh tracker. Allocates only on creation. */
export function createCameraPose(): CameraPose {
  let captured = false;
  let turned = false;
  let x = 0;
  let y = 0;
  let z = 0;
  const q = new Quaternion();
  const turn = new Quaternion();

  const capture = (cam: OrthographicCamera) => {
    x = cam.position.x;
    y = cam.position.y;
    z = cam.position.z;
    q.copy(cam.quaternion);
    captured = true;
  };

  return {
    apply(cam, azimuthOffset) {
      if (!captured) capture(cam);
      if (azimuthOffset === 0) {
        // Default pose: put it back if we had turned it, then follow whatever the camera is.
        if (turned) {
          cam.position.set(x, y, z);
          cam.quaternion.copy(q);
          turned = false;
        }
        capture(cam);
        return;
      }
      const a = rad(azimuthOffset);
      const sin = Math.sin(a);
      const cos = Math.cos(a);
      cam.position.set(x * cos + z * sin, y, -x * sin + z * cos);
      turn.setFromAxisAngle(UP, a);
      cam.quaternion.copy(turn).multiply(q);
      turned = true;
    },
  };
}
