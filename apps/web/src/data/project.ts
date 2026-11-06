import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/** The project the city shows until the viewer picks another: the engine's built-in one. */
export const DEFAULT_PROJECT_ID = "unsorted";

export interface ProjectSelection {
  projectId: string;
  select(projectId: string): void;
}

/**
 * Which project the city shows. `useDataSync` follows it, so choosing a project (a header chip,
 * a notification click) restarts the sync loop on that project and leaves everything else alone.
 */
export const projectSelection = createStore<ProjectSelection>()((set) => ({
  projectId: DEFAULT_PROJECT_ID,
  select: (projectId) => set((s) => (s.projectId === projectId ? s : { projectId })),
}));

/** One row of `GET /v1/projects`. */
export interface ProjectSummary {
  id: string;
  name: string;
  roots: string[];
  builtin: boolean;
  head: number;
  /** When the project's last event was stored (ISO 8601); null or absent when it has no events. */
  lastEventAt?: string | null;
}

const activityTime = (p: ProjectSummary): number =>
  p.lastEventAt ? Date.parse(p.lastEventAt) : Number.NEGATIVE_INFINITY;

/** Whether `a` was active more recently than `b`: later lastEventAt, then higher head. */
function moreRecent(a: ProjectSummary, b: ProjectSummary): boolean {
  const at = activityTime(a);
  const bt = activityTime(b);
  return at !== bt ? at > bt : a.head > b.head;
}

/**
 * The project the city opens on: the viewer's remembered choice while it still exists, else the
 * user project with the most recent last event (ties and projects with no events fall back to
 * head), else Unsorted.
 */
export function pickDefaultProject(projects: ProjectSummary[], remembered: string | null): string {
  if (remembered !== null && projects.some((p) => p.id === remembered)) return remembered;
  let best: ProjectSummary | undefined;
  for (const p of projects) {
    if (!p.builtin && (best === undefined || moreRecent(p, best))) best = p;
  }
  return best?.id ?? DEFAULT_PROJECT_ID;
}

export function useCurrentProjectId(): string {
  return useStore(projectSelection, (s) => s.projectId);
}

export function selectProject(projectId: string): void {
  projectSelection.getState().select(projectId);
}
