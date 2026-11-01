import { useFrame } from "@react-three/fiber";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { Group, Mesh, Sprite } from "three";
import { useData } from "../../../data/react.ts";
import { type DataStore, dataStore } from "../../../data/store.ts";
import { type AnchorSource, worldAnchors } from "../../../overlays/host/index.ts";
import { agentColors } from "../../agents/identity.ts";
import { LABEL_HEIGHT } from "../../agents/labelEntries.ts";
import { colorMaterial } from "../../agents/resources.ts";
import { emoteMaterial } from "../../attention/resources.ts";
import { agentAnchorId } from "../../movement/AgentLabels.tsx";
import { collapseCrew, crewMarkerLabel } from "./crew.ts";
import { subagentScale } from "./generation.ts";
import { parentIsWaiting, type SubagentPhase, stillFrame } from "./lifecycle.ts";
import { crewGeometries, crewMaterial, PILL_SIZE, pillMaterial } from "./resources.ts";
import { DOOR_RADIUS, MARKER_SPOT, workSpot } from "./spots.ts";
import {
  type CrewFamily,
  type CrewMember,
  type CrewTracker,
  createCrewTracker,
} from "./tracker.ts";

export interface SubagentCrewProps {
  store?: DataStore;
  anchors?: AnchorSource;
  /** Freeze the walking: bots jump between the door and their spot, and vanish without fading. */
  reducedMotion?: boolean;
}

// Same spot as the attention emote, so the parent's "..." sits where its other emotes do.
const EMOTE_SIZE = 0.2;
const EMOTE_Y = LABEL_HEIGHT - 0.05 - EMOTE_SIZE / 2;
const MARKER_Y = 0.5;
const CARRY_POSITION = [0, 0.6, 0.22] as const;
const HOP_HEIGHT = 0.05;
const HOP_RATE = 0.012;

/**
 * The subagents of every parent in the store, mounted inside the scene's `<Canvas>`: small bots
 * that walk out of the parent's door, return with a result cube and fade (ARCHITECTURE 2.9),
 * a "+N crew" marker when there are more than three, a count when they nest too deep, and a
 * "..." over the parent while it waits for them.
 */
export function SubagentCrew({
  store = dataStore,
  anchors = worldAnchors,
  reducedMotion = false,
}: SubagentCrewProps) {
  const agents = useData((s) => s.agents, store);
  const tracker = useRef<CrewTracker | null>(null);
  tracker.current ??= createCrewTracker();
  const crew = tracker.current;
  // Observing is idempotent: a repeated render never restarts a subagent's walk.
  const families = useMemo(() => crew.sync(agents, store.now()), [crew, agents, store]);
  return (
    <>
      {families.map((family) => (
        <CrewFamilyView
          key={family.parentId}
          family={family}
          tracker={crew}
          store={store}
          anchors={anchors}
          reducedMotion={reducedMotion}
        />
      ))}
    </>
  );
}

interface BotHandle {
  root: Group;
  body: Mesh;
  trim: Mesh;
  cube: Mesh;
  bodyHex: string;
  trimHex: string;
  generation: number;
}

interface CrewFamilyViewProps {
  family: CrewFamily;
  tracker: CrewTracker;
  store: DataStore;
  anchors: AnchorSource;
  reducedMotion: boolean;
}

function CrewFamilyView({ family, tracker, store, anchors, reducedMotion }: CrewFamilyViewProps) {
  const root = useRef<Group>(null);
  const waiting = useRef<Sprite>(null);
  const marker = useRef<Sprite>(null);
  const bots = useRef(new Map<string, BotHandle>());
  const fannedAtMs = useRef<number | undefined>(undefined);
  const markerCount = useRef(0);
  const live = useRef<string[]>([]);
  const phases = useRef<SubagentPhase[]>([]);
  const slots = useRef(new Map<string, number>());

  const register = useCallback((id: string, handle: BotHandle | null) => {
    if (handle === null) bots.current.delete(id);
    else bots.current.set(id, handle);
  }, []);

  const onMarkerClick = useCallback(() => {
    fannedAtMs.current = store.now();
  }, [store]);

  useFrame(() => {
    const g = root.current;
    if (g === null) return;
    const door = anchors.getAnchor(agentAnchorId(family.parentId));
    g.visible = door !== undefined;
    if (door === undefined) return;
    g.position.set(door[0], 0, door[2]);

    const nowMs = store.now();
    live.current.length = 0;
    phases.current.length = 0;
    for (const m of family.members) {
      const f = tracker.frame(m.id, nowMs);
      if (f === undefined) continue;
      phases.current.push(f.phase);
      if (f.phase !== "absent" && f.phase !== "gone") live.current.push(m.id);
    }
    const view = collapseCrew(live.current, {
      nowMs,
      ...(fannedAtMs.current === undefined ? {} : { fannedAtMs: fannedAtMs.current }),
    });
    slots.current.clear();
    live.current.forEach((id, i) => {
      slots.current.set(id, i);
    });
    const shown = new Set(view.individual);

    for (const [id, bot] of bots.current) {
      const found = tracker.frame(id, nowMs);
      const index = slots.current.get(id);
      if (found === undefined || index === undefined || !shown.has(id)) {
        bot.root.visible = false;
        continue;
      }
      const f = reducedMotion ? stillFrame(found) : found;
      const spot = workSpot(index, bot.generation);
      const radius = DOOR_RADIUS + (spot.radius - DOOR_RADIUS) * f.outward;
      const homeward =
        f.phase === "returning" || f.phase === "handing_over" || f.phase === "fading";
      const walking = f.phase === "walking_out" || f.phase === "returning";
      const hop = walking && !reducedMotion ? Math.abs(Math.sin(nowMs * HOP_RATE)) * HOP_HEIGHT : 0;
      bot.root.visible = f.opacity > 0;
      bot.root.position.set(Math.sin(spot.angle) * radius, hop, Math.cos(spot.angle) * radius);
      bot.root.rotation.y = homeward ? spot.angle + Math.PI : spot.angle;
      const body = crewMaterial(bot.bodyHex, f.opacity);
      if (bot.body.material !== body) bot.body.material = body;
      const trim = crewMaterial(bot.trimHex, f.opacity);
      if (bot.trim.material !== trim) bot.trim.material = trim;
      if (bot.cube.material !== trim) bot.cube.material = trim;
      bot.cube.visible = f.carrying;
    }

    const count = view.marker?.count ?? 0;
    if (marker.current !== null) {
      marker.current.visible = count > 0;
      if (count > 0 && count !== markerCount.current) {
        marker.current.material = pillMaterial(crewMarkerLabel(count));
      }
      markerCount.current = count;
    }
    if (waiting.current !== null) {
      waiting.current.visible = parentIsWaiting(phases.current) || family.deepCount > 0;
    }
  });

  return (
    <group ref={root} visible={false}>
      {family.members.map((member) => (
        <CrewBot key={member.id} member={member} register={register} />
      ))}
      <sprite
        ref={waiting}
        visible={false}
        material={emoteMaterial("...")}
        position={[0, EMOTE_Y, 0]}
        scale={[EMOTE_SIZE, EMOTE_SIZE, 1]}
        renderOrder={10}
      />
      {family.deepCount > 0 && (
        <sprite
          material={pillMaterial(`${family.deepCount} deeper`)}
          position={[0.4, EMOTE_Y, 0]}
          scale={[PILL_SIZE[0], PILL_SIZE[1], 1]}
          renderOrder={10}
        />
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a three.js sprite, not a DOM element; the accessible agent list mirrors the scene (ARCHITECTURE 2.8) */}
      <sprite
        ref={marker}
        visible={false}
        position={[
          Math.sin(MARKER_SPOT.angle) * MARKER_SPOT.radius,
          MARKER_Y,
          Math.cos(MARKER_SPOT.angle) * MARKER_SPOT.radius,
        ]}
        scale={[PILL_SIZE[0], PILL_SIZE[1], 1]}
        renderOrder={10}
        onClick={onMarkerClick}
      />
    </group>
  );
}

interface CrewBotProps {
  member: CrewMember;
  register: (id: string, handle: BotHandle | null) => void;
}

/** One subagent bot: a body mesh and a trim mesh from pooled geometry, and a result cube. */
function CrewBot({ member, register }: CrewBotProps) {
  const geo = crewGeometries();
  const colors = agentColors(member.view);
  const root = useRef<Group>(null);
  const body = useRef<Mesh>(null);
  const trim = useRef<Mesh>(null);
  const cube = useRef<Mesh>(null);

  useLayoutEffect(() => {
    if (root.current === null || body.current === null) return;
    if (trim.current === null || cube.current === null) return;
    register(member.id, {
      root: root.current,
      body: body.current,
      trim: trim.current,
      cube: cube.current,
      bodyHex: colors.body,
      trimHex: colors.trim,
      generation: member.generation,
    });
    return () => register(member.id, null);
  }, [register, member.id, member.generation, colors.body, colors.trim]);

  return (
    <group ref={root} visible={false} scale={subagentScale(member.generation)}>
      <mesh ref={body} geometry={geo.body} material={colorMaterial(colors.body)} />
      <mesh ref={trim} geometry={geo.trim} material={colorMaterial(colors.trim)} />
      <mesh
        ref={cube}
        geometry={geo.cube}
        material={colorMaterial(colors.trim)}
        visible={false}
        position={CARRY_POSITION}
      />
    </group>
  );
}
