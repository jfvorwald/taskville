import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { BoxGeometry, type Group } from "three";
import { useData } from "../../../data/react.ts";
import type { DataStore } from "../../../data/store.ts";
import { LabelSprite } from "../../agents/LabelSprite.tsx";
import { colorMaterial } from "../../agents/resources.ts";
import type { AgentView } from "../../agents/types.ts";
import { areaFor, createPose, workPose } from "../../agents/workLoop.ts";
import { CITY_LAYOUT } from "../../layout/index.ts";
import { teamAccessories } from "./accessories.ts";
import { teamScarfColor } from "./color.ts";
import { teammateIdle } from "./idle.ts";
import { dispatchQueue, type QueueState, teamProgress } from "./queue.ts";

const STATUS_COLOR: Record<QueueState, string> = {
  pending: "#9aa7ad",
  claimed: "#5aa9c9",
  completed: "#6eb58b",
  unknown: "#aaa2b8",
};

function AgentDecoration({
  view,
  hat,
  store,
  geometry,
}: {
  view: AgentView;
  hat: boolean;
  store: DataStore;
  geometry: BoxGeometry;
}) {
  const root = useRef<Group>(null);
  const sleeping = useRef<Group>(null);
  const guessed = useRef<Group>(null);
  const pose = useRef(createPose());
  const state = useData((s) => s.state, store);
  const idleInput = useMemo(() => {
    const agent = state?.agents[view.id];
    return {
      activity: view.activity,
      openToolCalls: Object.values(state?.toolCalls ?? {}).filter(
        (t) => t.agentId === view.id && t.phase === "running",
      ).length,
      claimedTasks: Object.values(state?.tasks ?? {}).filter(
        (t) =>
          t.assignedAgentIds.includes(view.id) &&
          (t.status === "assigned" || t.status === "running"),
      ).length,
      ...(agent === undefined ? {} : { lastEventAtMs: Date.parse(agent.lastSeenAt) }),
    };
  }, [state, view.id, view.activity]);
  useFrame((frame) => {
    if (root.current === null) return;
    const p = view.placement;
    const bob = workPose(areaFor(view.activity), frame.clock.elapsedTime, pose.current).bob;
    root.current.position.set(p.x, p.y + bob, p.z);
    root.current.rotation.y = p.heading;
    const idle = teammateIdle(idleInput, store.now());
    const show = view.kind === "teammate" && view.attention === undefined;
    if (sleeping.current) sleeping.current.visible = show && idle.idle && !idle.heuristic;
    if (guessed.current) guessed.current.visible = show && idle.idle && idle.heuristic;
  });
  return (
    <group ref={root}>
      {hat && (
        <group position={[0, 1.11, 0]} userData={{ hardHat: true }}>
          <mesh
            geometry={geometry}
            material={colorMaterial("#e4bd60")}
            scale={[0.38, 0.04, 0.34]}
          />
          <mesh
            geometry={geometry}
            material={colorMaterial("#e4bd60")}
            position={[0, 0.07, 0]}
            scale={[0.28, 0.12, 0.27]}
          />
        </group>
      )}
      <group ref={sleeping} visible={false}>
        <LabelSprite name="zzz" status="Idle" y={1.6} inverseScale={1} />
      </group>
      <group ref={guessed} visible={false}>
        <LabelSprite name="zzz" status="Quiet (heuristic)" y={1.6} inverseScale={1} />
      </group>
    </group>
  );
}

/** Decorations share the navigator's live placements; they never draw another agent body. */
export function TeamDecorations({
  views,
  store,
}: {
  views: readonly AgentView[];
  store: DataStore;
}) {
  const state = useData((s) => s.state, store);
  const geometry = useMemo(() => new BoxGeometry(1, 1, 1), []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const accessories = teamAccessories(views);
  const dispatch = CITY_LAYOUT.areas.find((a) => a.id === "dispatch");
  if (state === null || dispatch === undefined) return null;
  return (
    <>
      {accessories.map((a) => {
        const view = views.find((v) => v.id === a.agentId);
        return view === undefined ? null : (
          <AgentDecoration
            key={a.agentId}
            view={view}
            hat={a.hardHat}
            store={store}
            geometry={geometry}
          />
        );
      })}
      {Object.values(state.teams)
        .filter((t) => t.endedAt === undefined)
        .map((team, i) => {
          const queue = dispatchQueue(state, team.id);
          const progress = teamProgress(state, team.id);
          const mates = views.filter((v) => v.teamId === team.id && v.kind === "teammate");
          return (
            <TeamQueue
              key={team.id}
              teamId={team.id}
              name={team.name ?? "Team tasks"}
              queue={queue}
              progress={progress}
              mates={mates}
              geometry={geometry}
              position={[
                dispatch.footprint.cx + i * 1.6,
                dispatch.height + 0.6,
                dispatch.footprint.cz,
              ]}
              rowZ={dispatch.footprint.halfZ + 0.15}
            />
          );
        })}
    </>
  );
}

const PAGE_SIZE = 6;

function TeamQueue({
  teamId,
  name,
  queue,
  progress,
  mates,
  geometry,
  position,
  rowZ,
}: {
  teamId: string;
  name: string;
  queue: ReturnType<typeof dispatchQueue>;
  progress: ReturnType<typeof teamProgress>;
  mates: readonly AgentView[];
  geometry: BoxGeometry;
  position: [number, number, number];
  rowZ: number;
}) {
  const [page, setPage] = useState(0);
  const lastPage = Math.max(0, Math.ceil(queue.length / PAGE_SIZE) - 1);
  // Adjust during render so a shrinking snapshot cannot leave a blank page or
  // restore an obsolete offset when the queue grows again. The team key resets it.
  if (page > lastPage) setPage(lastPage);
  return (
    <group position={position}>
      <LabelSprite
        name={name}
        status={`${progress.completed}/${progress.total} completed`}
        y={0.5}
        inverseScale={1}
      />
      {mates.map((mate, n) => {
        const tasks = queue.filter((t) =>
          t.state === "completed" && t.completedByAgentId !== undefined
            ? t.completedByAgentId === mate.id
            : t.claimedBy.includes(mate.id),
        );
        const status = tasks.some((t) => t.state === "claimed")
          ? "claimed"
          : tasks.some((t) => t.state === "completed")
            ? "completed"
            : "unknown";
        return (
          <mesh
            key={mate.id}
            geometry={geometry}
            material={colorMaterial(STATUS_COLOR[status])}
            scale={[0.12, 0.12, 0.12]}
            position={[n * 0.22, 0, 0]}
            userData={{ teamId, teammateId: mate.id, state: status }}
          />
        );
      })}
      {queue.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((task, n) => (
        <group
          key={task.taskId}
          position={[0, 0.9 + n * 0.4, rowZ]}
          userData={{ teamId, taskId: task.taskId, state: task.state }}
        >
          <mesh
            geometry={geometry}
            material={colorMaterial(teamScarfColor(teamId))}
            scale={[0.12, 0.12, 0.12]}
          />
          <LabelSprite
            name={task.title ?? task.taskId}
            status={task.state}
            y={0.12}
            inverseScale={1}
          />
        </group>
      ))}
      {(["previous", "next"] as const).map((direction) => {
        const next = direction === "next";
        if (next ? page === lastPage : page === 0) return null;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: R3F scene group receives raycast clicks, not DOM events.
          <group
            key={direction}
            position={[next ? 0.65 : -0.65, 0.25, rowZ]}
            userData={{ teamId, queuePageDirection: direction }}
            onClick={(event) => {
              event.stopPropagation();
              setPage((current) => Math.max(0, Math.min(lastPage, current + (next ? 1 : -1))));
            }}
          >
            <mesh
              geometry={geometry}
              material={colorMaterial("#46535e")}
              scale={[1.15, 0.38, 0.16]}
            />
            <LabelSprite name={next ? "Next" : "Previous"} status="" y={0} inverseScale={1} />
          </group>
        );
      })}
    </group>
  );
}
