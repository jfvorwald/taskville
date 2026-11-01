import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { Group, Mesh } from "three";
import { agentColors } from "./identity.ts";
import { LabelSprite } from "./LabelSprite.tsx";
import { agentLabel } from "./label.ts";
import { LABEL_HEIGHT } from "./labelEntries.ts";
import { colorMaterial, sharedGeometries } from "./resources.ts";
import { agentScale } from "./scale.ts";
import type { AgentView } from "./types.ts";
import { areaFor, createPose, LOOP_SECONDS, workPose } from "./workLoop.ts";

export interface AgentBlockProps {
  agent: AgentView;
  /** Freeze the work loop on a still pose (reduced motion). */
  reducedMotion?: boolean;
  /** Draw the name and status as a local sprite label. False when the world-labels slot draws them. */
  localLabel?: boolean;
}

const STEP_EPSILON = 1e-4;

/**
 * One block humanoid, built from pooled geometry. The position comes from `agent.placement`
 * (navigation owns it); the frame loop only writes transforms and flips prop visibility.
 */
export function AgentBlock({ agent, reducedMotion = false, localLabel = true }: AgentBlockProps) {
  const geo = sharedGeometries();
  const colors = agentColors(agent);
  const body = colorMaterial(colors.body);
  const trim = colorMaterial(colors.trim);
  const scale = agentScale(agent.kind, agent.depth ?? 0);

  const root = useRef<Group>(null);
  const rightArm = useRef<Group>(null);
  const leftArm = useRef<Group>(null);
  const rightLeg = useRef<Mesh>(null);
  const leftLeg = useRef<Mesh>(null);
  const hammer = useRef<Group>(null);
  const beaker = useRef<Mesh>(null);
  const pages = useRef<Mesh>(null);
  const pose = useRef(createPose());
  const last = useRef({ x: agent.placement.x, z: agent.placement.z, stride: 0 });

  // `agent` is a new object on every store update, but the view's `placement` is stable, so the
  // frame loop reads the latest props through a ref instead of re-subscribing.
  const latest = useRef(agent);
  latest.current = agent;

  useFrame((state) => {
    const g = root.current;
    if (g === null) return;
    const v = latest.current;
    const p = v.placement;
    const seconds = reducedMotion ? LOOP_SECONDS * 0.25 : state.clock.elapsedTime;
    const pz = workPose(areaFor(v.activity), seconds, pose.current);

    g.position.set(p.x, p.y + pz.bob * scale, p.z);
    g.rotation.y = p.heading;

    const l = last.current;
    const moved = Math.abs(p.x - l.x) + Math.abs(p.z - l.z) > STEP_EPSILON;
    l.x = p.x;
    l.z = p.z;
    if (moved && !reducedMotion) l.stride += 0.25;
    const swing = moved ? Math.sin(l.stride) * 0.6 : 0;

    if (rightLeg.current !== null) rightLeg.current.rotation.x = swing;
    if (leftLeg.current !== null) leftLeg.current.rotation.x = -swing;
    if (rightArm.current !== null) rightArm.current.rotation.x = moved ? -swing : pz.rightArm;
    if (leftArm.current !== null) leftArm.current.rotation.x = moved ? swing : pz.leftArm;

    const showProp = !moved;
    if (hammer.current !== null) hammer.current.visible = showProp && pz.prop === "hammer";
    if (beaker.current !== null) beaker.current.visible = showProp && pz.prop === "beaker";
    if (pages.current !== null) pages.current.visible = showProp && pz.prop === "pages";
  });

  // Strings, not the label object: the sprite redraws only when the text really changes.
  const { name, status } = agentLabel(agent);

  return (
    <group ref={root} scale={scale} userData={{ agentId: agent.id }}>
      <mesh ref={leftLeg} geometry={geo.leg} material={body} position={[-0.1, 0.175, 0]} />
      <mesh ref={rightLeg} geometry={geo.leg} material={body} position={[0.1, 0.175, 0]} />
      <mesh geometry={geo.torso} material={body} position={[0, 0.55, 0]} />
      <mesh geometry={geo.scarf} material={trim} position={[0, 0.78, 0]} />
      <mesh geometry={geo.head} material={body} position={[0, 0.94, 0]} />
      <group ref={leftArm} position={[-0.24, 0.72, 0]}>
        <mesh geometry={geo.limb} material={body} position={[0, -0.17, 0]} />
      </group>
      <group ref={rightArm} position={[0.24, 0.72, 0]}>
        <mesh geometry={geo.limb} material={body} position={[0, -0.17, 0]} />
        <group ref={hammer} visible={false} position={[0, -0.34, 0]}>
          <mesh geometry={geo.hammerHandle} material={trim} position={[0, -0.1, 0]} />
          <mesh geometry={geo.hammerHead} material={trim} position={[0, -0.24, 0]} />
        </group>
        <mesh
          ref={beaker}
          geometry={geo.beaker}
          material={trim}
          visible={false}
          position={[0, -0.4, 0]}
        />
        <mesh
          ref={pages}
          geometry={geo.pages}
          material={trim}
          visible={false}
          position={[0, -0.36, 0.06]}
        />
      </group>
      {localLabel && (
        <LabelSprite name={name} status={status} y={LABEL_HEIGHT + 0.1} inverseScale={1 / scale} />
      )}
    </group>
  );
}
