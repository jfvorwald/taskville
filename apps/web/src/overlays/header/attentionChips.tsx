import type { OtherProjectNeedsYou } from "./attention.ts";
import styles from "./header.module.css";

export interface AttentionChipsProps {
  otherProjects: readonly OtherProjectNeedsYou[];
  /** Called with the project ID; the caller owns how the app changes project. */
  onSwitch(projectId: string): void;
}

/** One button per other project that needs you: `Beta: 2 need you`. Nothing when none does. */
export function AttentionChips({ otherProjects, onSwitch }: AttentionChipsProps) {
  if (otherProjects.length === 0) return null;
  return (
    <>
      {otherProjects.map((project) => (
        <button
          key={project.projectId}
          type="button"
          className={styles.chip}
          onClick={() => onSwitch(project.projectId)}
        >
          {`${project.name}: ${project.needsYou} ${project.needsYou === 1 ? "needs" : "need"} you`}
        </button>
      ))}
    </>
  );
}
