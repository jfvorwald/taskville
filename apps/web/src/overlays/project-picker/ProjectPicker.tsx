import { useEffect, useState } from "react";
import {
  type ProjectSummary,
  pickDefaultProject,
  projectSelection,
  selectProject,
  useCurrentProjectId,
} from "../../data/project.ts";
import { SESSION_HEADER } from "../../pairing/pair.ts";
import { useOptionalSession } from "../../pairing/session.tsx";
import styles from "../header/header.module.css";
import { InteractiveRegion } from "../host/InteractiveRegion.tsx";

const REMEMBERED_KEY = "taskville.project";

function readRemembered(): string | null {
  try {
    return window.localStorage.getItem(REMEMBERED_KEY);
  } catch {
    return null;
  }
}

function remember(projectId: string): void {
  try {
    window.localStorage.setItem(REMEMBERED_KEY, projectId);
  } catch {
    // Private mode or a full quota: the choice just is not remembered.
  }
}

/** The header's project switcher. Renders nothing until the app is paired. */
export function ProjectPicker() {
  const secret = useOptionalSession();
  return secret === null ? null : <PairedProjectPicker secret={secret} />;
}

function PairedProjectPicker({ secret }: { secret: string }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const currentProjectId = useCurrentProjectId();

  useEffect(() => {
    const controller = new AbortController();
    const startedOn = projectSelection.getState().projectId;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        const response = await globalThis.fetch("/v1/projects", {
          headers: { [SESSION_HEADER]: secret },
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body = (await response.json()) as { projects: ProjectSummary[] };
        if (controller.signal.aborted) return;
        setProjects(body.projects);
        // A chip clicked while the list was loading is the viewer's choice; keep it.
        if (projectSelection.getState().projectId === startedOn) {
          selectProject(pickDefaultProject(body.projects, readRemembered()));
        }
        // From here every change (picker, chip, Back to Unsorted) is the viewer's and is remembered.
        unsubscribe = projectSelection.subscribe((state, previous) => {
          if (state.projectId !== previous.projectId) remember(state.projectId);
        });
      } catch {
        // The city stays on its current project; the picker stays empty.
      }
    })();
    return () => {
      controller.abort();
      unsubscribe?.();
    };
  }, [secret]);

  if (projects.length === 0) return null;
  return (
    <InteractiveRegion>
      <select
        className={styles.picker}
        aria-label="Project"
        value={currentProjectId}
        onChange={(event) => selectProject(event.target.value)}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </InteractiveRegion>
  );
}
