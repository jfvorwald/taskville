import type { TaskStatus } from "@taskville/protocol";

// Task state graph (data-model.md "Task state transitions"):
//
//   queued -> assigned -> running <-> blocked
//                         running <-> awaiting_input
//                         running -> reviewing -> running | completed
//   any non-terminal -> failed | cancelled | unknown
//   terminal: completed, failed, cancelled
//
// A transition outside the graph is still applied (the source is the authority) but flagged.
// Reporting the current status again is not a transition. Nothing leads out of `unknown`
// except failed or cancelled, so a task whose status was unknown is flagged when it next gets a
// known status; that is the graph as written, and the flag only says the path was not seen.

const TERMINAL: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "cancelled"]);

const EDGES: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["assigned"],
  assigned: ["running"],
  running: ["blocked", "awaiting_input", "reviewing"],
  blocked: ["running"],
  awaiting_input: ["running"],
  reviewing: ["running", "completed"],
  completed: [],
  failed: [],
  cancelled: [],
  unknown: [],
};

export function isAllowedTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  if (TERMINAL.has(from)) return false;
  if (to === "failed" || to === "cancelled" || to === "unknown") return true;
  return EDGES[from].includes(to);
}
