import type { Attention } from "../../data/domain.ts";
import type { OverlaySettings } from "../host/types.ts";

// The global attention feed on the client (ARCHITECTURE.md 2.8 and 10): which projects have an
// agent that needs you or is in trouble, whichever project the city is showing. Everything here
// is pure; `attentionSync.ts` reads the engine's `GET /v1/attention/events` and these functions
// turn its frames into what the header, the tab title and desktop notifications show.

/** One project's `needs_you` and `trouble` records. */
export interface ProjectAttention {
  projectId: string;
  name: string;
  attention: readonly Attention[];
}

/** The latest records per project that has any, keyed by project ID. */
export type AttentionFeed = Readonly<Record<string, ProjectAttention>>;

export const EMPTY_ATTENTION_FEED: AttentionFeed = Object.freeze({});

export interface AttentionFrame {
  event: string;
  data: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A frame's project entry, or undefined when it is not the shape the engine sends. */
function readProject(value: unknown): ProjectAttention | undefined {
  if (!isRecord(value)) return undefined;
  const { projectId, name, attention } = value;
  if (typeof projectId !== "string" || typeof name !== "string" || !Array.isArray(attention)) {
    return undefined;
  }
  return { projectId, name, attention: attention as Attention[] };
}

/**
 * The feed after one frame. A snapshot replaces everything, an `attention` frame sets one project
 * (an empty set removes it). A heartbeat, an unknown frame or one that is not the expected shape
 * returns `feed` itself, so a subscriber sees no change. Never mutates `feed`.
 */
export function applyAttentionFrame(feed: AttentionFeed, frame: AttentionFrame): AttentionFeed {
  if (!isRecord(frame.data)) return feed;
  if (frame.event === "snapshot") {
    const { projects } = frame.data;
    if (!Array.isArray(projects)) return feed;
    const next: Record<string, ProjectAttention> = {};
    for (const entry of projects) {
      const project = readProject(entry);
      if (project && project.attention.length > 0) next[project.projectId] = project;
    }
    return next;
  }
  if (frame.event === "attention") {
    const project = readProject(frame.data);
    if (!project) return feed;
    const next = { ...feed };
    if (project.attention.length > 0) next[project.projectId] = project;
    else delete next[project.projectId];
    return next;
  }
  return feed;
}

export interface OtherProjectNeedsYou {
  projectId: string;
  name: string;
  needsYou: number;
}

export interface AttentionHeader {
  /** Agents that need you, summed over every project, the current one included. */
  needsYouTotal: number;
  /** Other projects with an agent that needs you, most first, then by name. */
  otherProjects: OtherProjectNeedsYou[];
}

/** How many distinct agents of the project have a `needs_you` record (agents, not requests). */
function needsYouAgents(project: ProjectAttention): number {
  const agents = new Set<string>();
  for (const record of project.attention) {
    if (record.level === "needs_you") agents.add(record.agentId);
  }
  return agents.size;
}

export function selectAttentionHeader(
  feed: AttentionFeed,
  currentProjectId: string | null,
): AttentionHeader {
  let needsYouTotal = 0;
  const otherProjects: OtherProjectNeedsYou[] = [];
  for (const project of Object.values(feed)) {
    const needsYou = needsYouAgents(project);
    needsYouTotal += needsYou;
    if (needsYou > 0 && project.projectId !== currentProjectId) {
      otherProjects.push({ projectId: project.projectId, name: project.name, needsYou });
    }
  }
  otherProjects.sort((a, b) => b.needsYou - a.needsYou || a.name.localeCompare(b.name));
  return { needsYouTotal, otherProjects };
}

const APP_NAME = "Taskville";

/** `(2) Taskville`, or plain `Taskville` when nothing needs you. */
export function formatTabTitle(needsYouTotal: number): string {
  const n = Number.isFinite(needsYouTotal) ? Math.max(0, Math.trunc(needsYouTotal)) : 0;
  return n > 0 ? `(${n}) ${APP_NAME}` : APP_NAME;
}

/** Desktop notifications are opt-in: only an explicit `true` turns them on. */
export function isDesktopNotificationsEnabled(settings: OverlaySettings): boolean {
  return settings.get<boolean>("desktopNotifications", false) === true;
}

export type NotificationPermissionState = "default" | "granted" | "denied";

export interface DesktopNotification {
  /** Stable for the entry (the project and the request that opened it): the notification `tag`. */
  key: string;
  projectId: string;
  projectName: string;
  agentId: string;
  requestId: string;
}

export interface NotificationView {
  visible: boolean;
  focused: boolean;
  /** The project the city is showing. */
  projectId: string | null;
}

export interface NotificationDecision {
  /** The feed before the change; undefined before the first snapshot, which notifies nothing. */
  previous: AttentionFeed | undefined;
  next: AttentionFeed;
  enabled: boolean;
  permission: NotificationPermissionState;
  view: NotificationView;
}

const requestKey = (projectId: string, requestId: string) => `${projectId}:${requestId}`;
// IDs are opaque text, so a separator could collide; a JSON-encoded tuple cannot.
const agentKey = (projectId: string, agentId: string) => JSON.stringify([projectId, agentId]);

/**
 * One notification per agent that enters `needs_you` in a project: it has a `needs_you` record in
 * `next` and none in `previous`. A request swap while the agent stays in needs-you (the bridge's
 * request replacing the telemetry one) is not an entry, and neither is a second request from an
 * agent that already needs you. Leaving and re-entering is a new entry. The notification names the
 * request that opened the entry. Silent when the viewer is already looking at that project in a
 * visible, focused tab.
 */
export function decideDesktopNotifications(input: NotificationDecision): DesktopNotification[] {
  const { previous, next, enabled, permission, view } = input;
  if (previous === undefined || !enabled || permission !== "granted") return [];
  const known = new Set<string>();
  for (const project of Object.values(previous)) {
    for (const record of project.attention) {
      if (record.level === "needs_you") known.add(agentKey(project.projectId, record.agentId));
    }
  }
  const fired: DesktopNotification[] = [];
  for (const project of Object.values(next)) {
    if (view.visible && view.focused && view.projectId === project.projectId) continue;
    for (const record of project.attention) {
      if (record.level !== "needs_you" || record.requestId === undefined) continue;
      const entered = agentKey(project.projectId, record.agentId);
      if (known.has(entered)) continue;
      known.add(entered);
      fired.push({
        key: requestKey(project.projectId, record.requestId),
        projectId: project.projectId,
        projectName: project.name,
        agentId: record.agentId,
        requestId: record.requestId,
      });
    }
  }
  return fired;
}
