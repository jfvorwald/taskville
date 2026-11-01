import type { ProjectState } from "../../../data/domain.ts";

export type QueueState =
  | "pending"
  | "claimed"
  | "completed"
  | "awaiting_input"
  | "reviewing"
  | "failed"
  | "cancelled"
  | "blocked"
  | "unknown";
export function dispatchQueue(state: Pick<ProjectState, "teams" | "tasks">, teamId: string) {
  const team = Object.hasOwn(state.teams, teamId) ? state.teams[teamId] : undefined;
  if (team === undefined) return [];
  const members = new Set([...team.memberAgentIds, team.leadAgentId]);
  const marker = teamId.indexOf(":team:");
  const prefix =
    marker < 0 ? undefined : `${teamId.slice(0, marker)}:task:${teamId.slice(marker + 6)}:`;
  return Object.values(state.tasks)
    .filter(
      (task) =>
        (prefix !== undefined && task.id.startsWith(prefix)) ||
        task.assignedAgentIds.some((id) => members.has(id)),
    )
    .sort((a, b) => {
      const at = a.createdAt ?? "";
      const bt = b.createdAt ?? "";
      return at < bt ? -1 : at > bt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((task) => ({
      taskId: task.id,
      ...(task.title === undefined ? {} : { title: task.title }),
      state: (task.status === "completed"
        ? "completed"
        : task.status === "assigned" || task.status === "running"
          ? "claimed"
          : task.status === "queued"
            ? "pending"
            : task.status === "failed" ||
                task.status === "cancelled" ||
                task.status === "blocked" ||
                task.status === "awaiting_input" ||
                task.status === "reviewing"
              ? task.status
              : "unknown") as QueueState,
      claimedBy: task.assignedAgentIds,
      ...(task.completedByAgentId === undefined
        ? {}
        : { completedByAgentId: task.completedByAgentId }),
    }));
}
export function teamProgress(state: Pick<ProjectState, "teams" | "tasks">, teamId: string) {
  const queue = dispatchQueue(state, teamId);
  return { completed: queue.filter((t) => t.state === "completed").length, total: queue.length };
}
