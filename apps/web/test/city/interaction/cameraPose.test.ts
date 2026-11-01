import { OrthographicCamera, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { createCameraPose } from "../../../src/city/interaction/cameraPose.ts";

const UP = new Vector3(0, 1, 0);

function defaultCamera() {
  const cam = new OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
  cam.position.set(10, 8, 10);
  cam.lookAt(0, 0, 0);
  return cam;
}

function snapshot(cam: OrthographicCamera) {
  return { p: cam.position.clone(), q: cam.quaternion.clone() };
}

function expectPose(cam: OrthographicCamera, want: ReturnType<typeof snapshot>) {
  expect(cam.position.x).toBeCloseTo(want.p.x, 6);
  expect(cam.position.y).toBeCloseTo(want.p.y, 6);
  expect(cam.position.z).toBeCloseTo(want.p.z, 6);
  expect(cam.quaternion.angleTo(want.q)).toBeCloseTo(0, 6);
}

describe("camera pose (turn about the vertical axis through the city center)", () => {
  it("turns the default pose and puts it back exactly at offset zero", () => {
    const cam = defaultCamera();
    const home = snapshot(cam);
    const pose = createCameraPose();
    pose.apply(cam, 0);
    expectPose(cam, home);

    pose.apply(cam, 90);
    expect(cam.position.x).toBeCloseTo(10, 6);
    expect(cam.position.y).toBeCloseTo(8, 6);
    expect(cam.position.z).toBeCloseTo(-10, 6);
    const turned = new Quaternion().setFromAxisAngle(UP, Math.PI / 2).multiply(home.q);
    expect(cam.quaternion.angleTo(turned)).toBeCloseTo(0, 6);

    pose.apply(cam, 0);
    expectPose(cam, home);
  });

  it("does not accumulate when the same offset is applied every frame", () => {
    const cam = defaultCamera();
    const pose = createCameraPose();
    pose.apply(cam, 0);
    pose.apply(cam, 40);
    const once = snapshot(cam);
    pose.apply(cam, 40);
    pose.apply(cam, 40);
    expectPose(cam, once);
  });

  it("after a remount at a non-zero offset, turns from the camera's default pose, never the origin", () => {
    // The rig outlives the Canvas: a new Canvas gets a fresh camera in its default pose while the
    // rig still holds the old offset, so the new pose tracker's first call has a non-zero offset.
    const cam = defaultCamera();
    const home = snapshot(cam);
    const pose = createCameraPose();

    pose.apply(cam, 90);
    expect(cam.position.length()).toBeGreaterThan(1);
    expect(cam.position.x).toBeCloseTo(10, 6);
    expect(cam.position.y).toBeCloseTo(8, 6);
    expect(cam.position.z).toBeCloseTo(-10, 6);
    expect(cam.quaternion.angleTo(new Quaternion())).toBeGreaterThan(0.1);

    pose.apply(cam, 0);
    expectPose(cam, home);
  });
});
