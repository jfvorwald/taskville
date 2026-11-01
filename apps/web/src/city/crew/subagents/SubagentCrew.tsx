import { useFrame } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Group, type Mesh, type Object3D, type Sprite, Vector3 } from "three";
import type { Agent } from "../../../data/domain.ts";
import { useData } from "../../../data/react.ts";
import { type DataStore, dataStore } from "../../../data/store.ts";
import { type AnchorSource, worldAnchors } from "../../../overlays/host/index.ts";
import { agentColors } from "../../agents/identity.ts";
import { LABEL_HEIGHT } from "../../agents/labelEntries.ts";
import { colorMaterial } from "../../agents/resources.ts";
import { CITY_LAYOUT } from "../../layout/index.ts";
import { agentAnchorId } from "../../movement/AgentLabels.tsx";
import { collapseCrew, crewMarkerLabel } from "./crew.ts";
import { crewLineage, subagentScale } from "./generation.ts";
import { parentIsWaiting, type SubagentPhase, stillFrame } from "./lifecycle.ts";
import { crewGeometries, crewMaterial, PILL_SIZE, pillMaterial } from "./resources.ts";
import { doorRadius, markerSpot, reachOf, workSpot } from "./spots.ts";
import { type CrewBotTint, crewBotTint, TINT_HEX } from "./tint.ts";
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
  const attention = useData((s) => s.attention, store);
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const lineages = useMemo(
    () => new Map(agents.map((a) => [a.id, crewLineage(a, byId)])),
    [agents, byId],
  );
  // Hidden members carry the urgency of their whole subtree, including counted descendants.
  const subtreeTints = useMemo(() => {
    const result = new Map<string, CrewBotTint>();
    for (const agent of agents) {
      if (agent.finishedAt !== undefined) continue;
      const tint = crewBotTint(agent, attention);
      if (tint === undefined) continue;
      for (const id of [agent.id, ...(lineages.get(agent.id) ?? [])]) {
        if (result.get(id)?.hue !== "red") result.set(id, tint);
      }
    }
    return result;
  }, [agents, attention, lineages]);
  const tracker = useRef<CrewTracker | null>(null);
  tracker.current ??= createCrewTracker();
  const crew = tracker.current;
  const [lifecycleVersion, setLifecycleVersion] = useState(0);
  const onSettled = useCallback(() => setLifecycleVersion((value) => value + 1), []);
  // Where each bot stands in the world, for the families that walk out of a bot.
  const places = useRef(new Map<string, Place>());
  // Observing is idempotent: a repeated render never restarts a subagent's walk.
  // biome-ignore lint/correctness/useExhaustiveDependencies: lifecycleVersion reaps elapsed visits without another store event.
  const families = useMemo(
    () => crew.sync(agents, store.now()),
    [crew, agents, store, lifecycleVersion],
  );
  return (
    <>
      {families.map((family) => (
        <CrewFamilyView
          key={family.parentId}
          family={family}
          tracker={crew}
          places={places.current}
          store={store}
          anchors={anchors}
          reducedMotion={reducedMotion}
          onSettled={onSettled}
          byId={byId}
          subtreeTints={subtreeTints}
        />
      ))}
      {attention
        .filter((a) => a.level === "needs_you")
        .map((a) => (
          <NeedsYouDot
            key={a.agentId}
            lineage={lineages.get(a.agentId)}
            places={places.current}
            anchors={anchors}
          />
        ))}
    </>
  );
}

interface Place {
  x: number;
  z: number;
  /** Behind a "+N crew" marker: the bots that walked out of it are out of sight too. */
  hidden?: boolean;
  /** The actually visible marker representing this hidden branch. */
  representative?: Object3D | null;
}

interface BotHandle {
  root: Group;
  body: Mesh;
  trim: Mesh;
  cube: Mesh;
  bodyHex: string;
  trimHex: string;
}

interface CrewFamilyViewProps {
  family: CrewFamily;
  tracker: CrewTracker;
  places: Map<string, Place>;
  store: DataStore;
  anchors: AnchorSource;
  reducedMotion: boolean;
  onSettled: () => void;
  byId: ReadonlyMap<string, Agent>;
  subtreeTints: ReadonlyMap<string, CrewBotTint>;
}

function CrewFamilyView({
  family,
  tracker,
  places,
  store,
  anchors,
  reducedMotion,
  onSettled,
  byId,
  subtreeTints,
}: CrewFamilyViewProps) {
  const attention = useData((s) => s.attention, store);
  // A subagent that needs you is still red, though it is no longer a block agent with a ring.
  const tints = useMemo(
    () => new Map(family.members.map((m) => [m.id, crewBotTint(m, attention)])),
    [family.members, attention],
  );
  const tintsRef = useRef<ReadonlyMap<string, CrewBotTint | undefined>>(tints);
  tintsRef.current = tints;
  const reach = reachOf(family.parentGeneration);
  const ancestorIds = useMemo(() => {
    const parent = byId.get(family.parentId);
    return [family.parentId, ...(parent === undefined ? [] : (crewLineage(parent, byId) ?? []))];
  }, [family.parentId, byId]);
  const deepTint = family.deepIds.reduce<CrewBotTint | undefined>((tint, id) => {
    const next = crewBotTint({ id }, attention);
    return tint?.hue === "red" ? tint : (next ?? tint);
  }, undefined);
  const marked = markerSpot(reach);
  const emoteY = EMOTE_Y * reach + (1 - reach) * 0.4;
  const root = useRef<Group>(null);
  const waiting = useRef<Sprite>(null);
  const marker = useRef<Sprite>(null);
  const bots = useRef(new Map<string, BotHandle>());
  const fannedAtMs = useRef<number | undefined>(undefined);
  const markerCount = useRef(0);
  const markerHue = useRef<CrewBotTint["hue"] | undefined>(undefined);
  const live = useRef<string[]>([]);
  const phases = useRef<SubagentPhase[]>([]);
  const slots = useRef(new Map<string, number>());
  // Where this family's door last was while its parent was in sight.
  const lastDoor = useRef<Place | undefined>(undefined);
  const anchorPoint = useRef<[number, number, number]>([0, 0, 0]);
  const settled = useRef(false);
  const markerPosition = useMemo(() => new Vector3(), []);

  // Private presentation metadata, read by InteractionLayer without changing actual agent IDs.
  const representHidden = (id: string, bot: BotHandle, representative: Object3D | null) => {
    for (let object = representative; object !== null; object = object.parent) {
      if (!object.visible) {
        representative = null;
        break;
      }
    }
    if (representative?.parent === null) representative = null;
    // Finishing suppresses this agent's fallback, but its running descendants still inherit it.
    const ownRepresentative = byId.get(id)?.finishedAt === undefined ? representative : null;
    bot.root.userData.crewRepresentative = ownRepresentative;
    if (ownRepresentative === null) anchors.removeAnchor(agentAnchorId(id));
    else {
      ownRepresentative.getWorldPosition(markerPosition);
      const point = anchorPoint.current;
      point[0] = markerPosition.x;
      point[1] = markerPosition.y;
      point[2] = markerPosition.z;
      anchors.setAnchor(agentAnchorId(id), point);
    }
    return representative;
  };

  const register = useCallback(
    (id: string, handle: BotHandle | null) => {
      if (handle === null) {
        const bot = bots.current.get(id);
        if (bot !== undefined) bot.root.userData.crewRepresentative = null;
        bots.current.delete(id);
        anchors.removeAnchor(agentAnchorId(id));
      } else bots.current.set(id, handle);
    },
    [anchors],
  );
  // The ids are the family's, so the places are dropped with the bots. A store update that keeps a
  // member keeps its place (and its hidden flag): its crew must not reappear behind the marker.
  const placed = useRef<string[]>([]);
  useEffect(() => {
    settled.current = false;
    const ids = family.members.map((m) => m.id);
    const kept = new Set(ids);
    for (const id of placed.current) {
      if (!kept.has(id)) {
        places.delete(id);
        anchors.removeAnchor(agentAnchorId(id));
      }
    }
    placed.current = ids;
  }, [family.members, places, anchors]);
  useEffect(
    () => () => {
      for (const id of placed.current) {
        places.delete(id);
        anchors.removeAnchor(agentAnchorId(id));
      }
    },
    [places, anchors],
  );

  const onMarkerClick = useCallback(() => {
    fannedAtMs.current = store.now();
  }, [store]);

  useFrame(() => {
    const g = root.current;
    if (g === null) return;
    const nowMs = store.now();
    live.current.length = 0;
    phases.current.length = 0;
    for (const member of family.members) {
      const frame = tracker.frame(member.id, nowMs);
      if (frame === undefined) continue;
      if (frame.phase === "gone" && !settled.current) {
        settled.current = true;
        onSettled();
      }
      phases.current.push(frame.phase);
      if (frame.phase !== "absent" && frame.phase !== "gone") live.current.push(member.id);
    }
    // A family of a top-level parent follows the parent's anchor; one of a subagent follows that
    // bot. When the parent is out of sight (finished and faded, left the city, behind the
    // marker) the family stays where it last stood: a running subagent never disappears.
    const parentPlace = places.get(family.parentId);
    if (parentPlace?.hidden === true) {
      // The parent bot is behind a "+N crew" marker: its crew goes out of sight with it, all the
      // way down.
      g.visible = false;
      for (const [id, bot] of bots.current) {
        bot.root.visible = false;
        const frame = tracker.frame(id, nowMs);
        const representative = representHidden(
          id,
          bot,
          frame === undefined || frame.phase === "gone" || frame.phase === "absent"
            ? null
            : (parentPlace.representative ?? null),
        );
        const place = places.get(id);
        if (place !== undefined) {
          place.hidden = true;
          place.representative = representative;
        } else places.set(id, { x: 0, z: 0, hidden: true, representative });
      }
      return;
    }
    const anchor =
      family.parentGeneration === 0 ? anchors.getAnchor(agentAnchorId(family.parentId)) : undefined;
    const liveX = anchor === undefined ? parentPlace?.x : anchor[0];
    const liveZ = anchor === undefined ? parentPlace?.z : anchor[2];
    if (liveX !== undefined && liveZ !== undefined) {
      if (lastDoor.current === undefined) lastDoor.current = { x: liveX, z: liveZ };
      else {
        lastDoor.current.x = liveX;
        lastDoor.current.z = liveZ;
      }
    }
    const stood = lastDoor.current;
    if (stood === undefined) {
      // A reload may miss a finished parent's place. Use the nearest drawn ancestor, then plaza.
      for (const id of ancestorIds) {
        const place = places.get(id);
        const point =
          id === ancestorIds[ancestorIds.length - 1]
            ? anchors.getAnchor(agentAnchorId(id))
            : undefined;
        if (place !== undefined && !place.hidden) {
          lastDoor.current = { x: place.x, z: place.z };
          break;
        }
        if (point !== undefined) {
          lastDoor.current = { x: point[0], z: point[2] };
          break;
        }
      }
      lastDoor.current ??= { x: CITY_LAYOUT.plaza.cx, z: CITY_LAYOUT.plaza.cz };
    }
    g.visible = true;
    const doorX = (lastDoor.current as Place).x;
    const doorZ = (lastDoor.current as Place).z;
    g.position.set(doorX, 0, doorZ);

    const view = collapseCrew(live.current, {
      nowMs,
      ...(fannedAtMs.current === undefined ? {} : { fannedAtMs: fannedAtMs.current }),
    });
    slots.current.clear();
    live.current.forEach((id, i) => {
      slots.current.set(id, i);
    });
    const shown = new Set(view.individual);
    if (marker.current !== null) marker.current.visible = (view.marker?.count ?? 0) > 0;

    for (const [id, bot] of bots.current) {
      const found = tracker.frame(id, nowMs);
      const index = slots.current.get(id);
      if (found === undefined || index === undefined || !shown.has(id)) {
        bot.root.visible = false;
        const representative = representHidden(
          id,
          bot,
          found === undefined || index === undefined ? null : marker.current,
        );
        // Gone: its running crew stays where it last stood. Behind the marker: its crew goes with it.
        if (found === undefined || index === undefined) places.delete(id);
        else {
          const hiddenPlace = places.get(id);
          if (hiddenPlace === undefined)
            places.set(id, { x: doorX, z: doorZ, hidden: true, representative });
          else {
            hiddenPlace.hidden = true;
            hiddenPlace.representative = representative;
          }
        }
        continue;
      }
      const f = reducedMotion ? stillFrame(found) : found;
      const spot = workSpot(index, reach);
      const door = doorRadius(reach);
      const radius = door + (spot.radius - door) * f.outward;
      const homeward =
        f.phase === "returning" || f.phase === "handing_over" || f.phase === "fading";
      const walking = f.phase === "walking_out" || f.phase === "returning";
      const hop = walking && !reducedMotion ? Math.abs(Math.sin(nowMs * HOP_RATE)) * HOP_HEIGHT : 0;
      bot.root.visible = f.opacity > 0;
      bot.root.userData.crewRepresentative = bot.root.visible ? bot.root : null;
      const x = Math.sin(spot.angle) * radius;
      const z = Math.cos(spot.angle) * radius;
      bot.root.position.set(x, hop, z);
      if (bot.root.visible) {
        const point = anchorPoint.current;
        point[0] = doorX + x;
        point[1] = hop + LABEL_HEIGHT * bot.root.scale.y;
        point[2] = doorZ + z;
        anchors.setAnchor(agentAnchorId(id), point);
      } else anchors.removeAnchor(agentAnchorId(id));
      const place = places.get(id);
      if (place === undefined) places.set(id, { x: doorX + x, z: doorZ + z });
      else {
        place.x = doorX + x;
        place.z = doorZ + z;
        place.hidden = false;
        place.representative = null;
      }
      bot.root.rotation.y = homeward ? spot.angle + Math.PI : spot.angle;
      const tint = tintsRef.current.get(id);
      const tinted = tint === undefined ? undefined : TINT_HEX[tint.hue];
      const body = crewMaterial(tinted ?? bot.bodyHex, f.opacity);
      if (bot.body.material !== body) bot.body.material = body;
      const trim = crewMaterial(tinted ?? bot.trimHex, f.opacity);
      if (bot.trim.material !== trim) bot.trim.material = trim;
      if (bot.cube.material !== trim) bot.cube.material = trim;
      bot.cube.visible = f.carrying;
    }

    const count = view.marker?.count ?? 0;
    if (marker.current !== null) {
      marker.current.visible = count > 0;
      // A hidden bot that needs you must still show: the marker takes the most urgent hue.
      let urgent: CrewBotTint["hue"] | undefined;
      for (const id of view.marker?.hiddenIds ?? []) {
        const hue = subtreeTints.get(id)?.hue;
        if (hue === "red") urgent = "red";
        else if (hue !== undefined && urgent === undefined) urgent = hue;
      }
      if (count > 0 && (count !== markerCount.current || urgent !== markerHue.current)) {
        marker.current.material = pillMaterial(
          crewMarkerLabel(count),
          urgent === undefined ? undefined : TINT_HEX[urgent],
        );
      }
      markerCount.current = count;
      markerHue.current = urgent;
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
        material={pillMaterial("... crew")}
        position={[0, emoteY, 0]}
        scale={[EMOTE_SIZE, EMOTE_SIZE, 1]}
        renderOrder={10}
      />
      {family.deepCount > 0 && (
        <sprite
          material={pillMaterial(
            `${family.deepCount} deeper`,
            deepTint === undefined ? undefined : TINT_HEX[deepTint.hue],
          )}
          position={[0.4, emoteY, 0]}
          scale={[PILL_SIZE[0], PILL_SIZE[1], 1]}
          renderOrder={10}
        />
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a three.js sprite, not a DOM element; the accessible agent list mirrors the scene (ARCHITECTURE 2.8) */}
      <sprite
        ref={marker}
        visible={false}
        position={[
          Math.sin(marked.angle) * marked.radius,
          MARKER_Y * reach,
          Math.cos(marked.angle) * marked.radius,
        ]}
        scale={[PILL_SIZE[0], PILL_SIZE[1], 1]}
        renderOrder={10}
        onClick={onMarkerClick}
        userData={{ crewControl: true }}
      />
    </group>
  );
}

/** Each request points at its nearest currently drawn ancestor, including after fan-out. */
function NeedsYouDot({
  lineage,
  places,
  anchors,
}: {
  lineage: readonly string[] | undefined;
  places: ReadonlyMap<string, Place>;
  anchors: AnchorSource;
}) {
  const dot = useRef<Mesh>(null);
  useFrame(() => {
    const mesh = dot.current;
    if (mesh === null) return;
    mesh.visible = false;
    if (lineage === undefined) return;
    for (const id of lineage) {
      const place = places.get(id);
      const anchor =
        id === lineage[lineage.length - 1] ? anchors.getAnchor(agentAnchorId(id)) : undefined;
      if (place !== undefined && !place.hidden) mesh.position.set(place.x + 0.2, 1, place.z);
      else if (anchor !== undefined) mesh.position.set(anchor[0] + 0.2, 1.3, anchor[2]);
      else continue;
      mesh.userData.needsYouDot = id;
      mesh.visible = true;
      break;
    }
  });
  return (
    <mesh
      ref={dot}
      visible={false}
      geometry={crewGeometries().dot}
      material={colorMaterial(TINT_HEX.red)}
    />
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
    });
    return () => register(member.id, null);
  }, [register, member.id, colors.body, colors.trim]);

  return (
    <group
      ref={root}
      visible={false}
      scale={subagentScale(member.generation)}
      userData={{ agentId: member.id }}
    >
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
