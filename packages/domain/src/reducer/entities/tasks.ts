import type { StoredEnvelopeOf, TaskStatus } from "@taskville/protocol";
import { appendUnique, getOwn, omit, optional, put } from "./maps.ts";
import { isAllowedTransition } from "./task-graph.ts";
import type { EntitiesState, Task } from "./types.ts";

// Tasks. Task statuses are task data only and never raise attention by themselves. A task event
// may arrive before task.created (sources race); the task is then recorded without a title or
// creation time rather than with invented ones.

function withStatus(task: Task, to: TaskStatus, sourceValue: string | undefined, at: string): Task {
  const allowed = isAllowedTransition(task.status, to);
  return {
    ...omit(task, ["sourceValue", "transitionWarning"]),
    status: to,
    ...optional("sourceValue", to === "unknown" ? sourceValue : undefined),
    ...optional(
      "transitionWarning",
      allowed ? task.transitionWarning : { from: task.status, to, at },
    ),
    updatedAt: at,
  };
}

function newTask(id: string, status: TaskStatus, at: string): Task {
  return { id, status, assignedAgentIds: [], relatedTaskIds: [], updatedAt: at };
}

export function applyTaskCreated(
  s: EntitiesState,
  e: StoredEnvelopeOf<"task.created">,
  taskId: string,
): EntitiesState {
  const { title, relatedTaskIds } = e.payload;
  const existing = getOwn(s.tasks, taskId) ?? newTask(taskId, "queued", e.occurredAt);
  const task: Task = {
    ...existing,
    title,
    ...optional("relatedTaskIds", relatedTaskIds),
    createdAt: existing.createdAt ?? e.occurredAt,
    updatedAt: e.occurredAt,
  };
  return { ...s, tasks: put(s.tasks, taskId, task) };
}

export function applyTaskAssigned(
  s: EntitiesState,
  e: StoredEnvelopeOf<"task.assigned">,
  taskId: string,
): EntitiesState {
  const existing = getOwn(s.tasks, taskId);
  const base =
    existing === undefined
      ? newTask(taskId, "assigned", e.occurredAt)
      : withStatus(existing, "assigned", undefined, e.occurredAt);
  const task: Task = {
    ...base,
    assignedAgentIds: appendUnique(base.assignedAgentIds, e.payload.agentIds),
  };
  return { ...s, tasks: put(s.tasks, taskId, task) };
}

export function applyTaskStatusChanged(
  s: EntitiesState,
  e: StoredEnvelopeOf<"task.status_changed">,
  taskId: string,
): EntitiesState {
  const { status, sourceValue } = e.payload;
  const existing = getOwn(s.tasks, taskId);
  const task =
    existing === undefined
      ? {
          ...newTask(taskId, status, e.occurredAt),
          ...optional("sourceValue", status === "unknown" ? sourceValue : undefined),
        }
      : withStatus(existing, status, sourceValue, e.occurredAt);
  return { ...s, tasks: put(s.tasks, taskId, task) };
}

export function applyTaskHandoff(
  s: EntitiesState,
  e: StoredEnvelopeOf<"task.handoff">,
  taskId: string,
): EntitiesState {
  const { fromAgentId, toAgentId } = e.payload;
  const existing = getOwn(s.tasks, taskId) ?? newTask(taskId, "unknown", e.occurredAt);
  const task: Task = {
    ...existing,
    assignedAgentIds: appendUnique(
      existing.assignedAgentIds.filter((id) => id !== fromAgentId),
      [toAgentId],
    ),
    updatedAt: e.occurredAt,
  };
  return { ...s, tasks: put(s.tasks, taskId, task) };
}
