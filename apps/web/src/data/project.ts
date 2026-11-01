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

export function useCurrentProjectId(): string {
  return useStore(projectSelection, (s) => s.projectId);
}

export function selectProject(projectId: string): void {
  projectSelection.getState().select(projectId);
}
