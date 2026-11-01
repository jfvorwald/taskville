import { type OrthographicCamera, Quaternion, Vector3 } from "three";

const UP = new Vector3(0, 1, 0);
const rad = (deg: number) => (deg * Math.PI) / 180;

export interface CameraPose {
  /**
   * Puts the camera at its default pose turned by `azimuthOffset` degrees about the vertical axis
   * through the city center. The default pose is the one the camera has when it is first seen
   * and whenever the offset is zero (it is read, not recomputed); a turned pose is always computed
   * from it, so repeated calls do not accumulate.
   */
  apply(camera: OrthographicCamera, azimuthOffset: number): void;
}

interface DefaultPose {
  x: number;
  y: number;
  z: number;
  q: Quaternion;
  turned: boolean;
}

// The default pose belongs to the camera, not to a tracker: a tracker made later (a remounted
// driver) on a camera that is still turned must not adopt the turned pose as its default.
const poses = new WeakMap<OrthographicCamera, DefaultPose>();

function capture(cam: OrthographicCamera, pose: DefaultPose) {
  pose.x = cam.position.x;
  pose.y = cam.position.y;
  pose.z = cam.position.z;
  pose.q.copy(cam.quaternion);
}

/** Allocates only on creation, and once per camera on its first `apply`. */
export function createCameraPose(): CameraPose {
  const turn = new Quaternion();

  return {
    apply(cam, azimuthOffset) {
      let pose = poses.get(cam);
      if (pose === undefined) {
        pose = { x: 0, y: 0, z: 0, q: new Quaternion(), turned: false };
        capture(cam, pose);
        poses.set(cam, pose);
      }
      if (azimuthOffset === 0) {
        // Default pose: put it back if we had turned it, then follow whatever the camera is.
        if (pose.turned) {
          cam.position.set(pose.x, pose.y, pose.z);
          cam.quaternion.copy(pose.q);
          pose.turned = false;
        }
        capture(cam, pose);
        return;
      }
      const a = rad(azimuthOffset);
      const sin = Math.sin(a);
      const cos = Math.cos(a);
      cam.position.set(pose.x * cos + pose.z * sin, pose.y, -pose.x * sin + pose.z * cos);
      turn.setFromAxisAngle(UP, a);
      cam.quaternion.copy(turn).multiply(pose.q);
      pose.turned = true;
    },
  };
}
