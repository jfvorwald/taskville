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

async function fetchProjects(
  secret: string,
  signal?: AbortSignal,
): Promise<ProjectSummary[] | null> {
  const response = await globalThis.fetch("/v1/projects", {
    headers: { [SESSION_HEADER]: secret },
    signal: signal ?? null,
  });
  if (!response.ok) return null;
  return ((await response.json()) as { projects: ProjectSummary[] }).projects;
}

function PairedProjectPicker({ secret }: { secret: string }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const currentProjectId = useCurrentProjectId();

  useEffect(() => {
    const controller = new AbortController();
    // Every change from here on (picker, chip, Back to Unsorted) is the viewer's and is
    // remembered, including changes made while the list is still loading. The fetched default
    // applies only when the viewer made no choice at all before it arrived.
    let viewerChose = false;
    let applyingDefault = false;
    const unsubscribe = projectSelection.subscribe((state, previous) => {
      if (state.projectId === previous.projectId || applyingDefault) return;
      viewerChose = true;
      remember(state.projectId);
    });
    void (async () => {
      try {
        const list = await fetchProjects(secret, controller.signal);
        if (list === null || controller.signal.aborted) return;
        setProjects(list);
        if (!viewerChose) {
          applyingDefault = true;
          selectProject(pickDefaultProject(list, readRemembered()));
          applyingDefault = false;
        }
      } catch {
        // The city stays on its current project; the picker stays empty.
      }
    })();
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [secret]);

  // Projects added with the CLI while the page is open show up the next time the picker is used.
  const refresh = () => {
    void fetchProjects(secret)
      .then((list) => {
        if (list !== null) setProjects(list);
      })
      .catch(() => {});
  };

  if (projects.length === 0) return null;
  return (
    <InteractiveRegion>
      <select
        className={styles.picker}
        aria-label="Project"
        value={currentProjectId}
        onFocus={refresh}
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
