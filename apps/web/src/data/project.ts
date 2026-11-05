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
}

/**
 * The project the city opens on: the viewer's remembered choice while it still exists, else the
 * user project with the highest head (most recently active), else Unsorted.
 */
export function pickDefaultProject(projects: ProjectSummary[], remembered: string | null): string {
  if (remembered !== null && projects.some((p) => p.id === remembered)) return remembered;
  let best: ProjectSummary | undefined;
  for (const p of projects) {
    if (!p.builtin && (best === undefined || p.head > best.head)) best = p;
  }
  return best?.id ?? DEFAULT_PROJECT_ID;
}

export function useCurrentProjectId(): string {
  return useStore(projectSelection, (s) => s.projectId);
}

export function selectProject(projectId: string): void {
  projectSelection.getState().select(projectId);
}
