import { type ReleaseIdentity, shortReleaseId } from "./identity.ts";
import styles from "./release.module.css";

/** Quiet, low-contrast `staging · 20261106-abc` in the header. Nothing without an identity. */
export function ReleaseBadge({ release }: { release: ReleaseIdentity | null }) {
  if (release === null) return null;
  return (
    <span className={styles.badge} data-environment={release.environment}>
      {release.environment} · {shortReleaseId(release.id)}
    </span>
  );
}

/** A clearly visible banner, only for the staging environment. */
export function ReleaseBanner({ release }: { release: ReleaseIdentity | null }) {
  if (release?.environment !== "staging") return null;
  return (
    <p className={styles.banner} role="status">
      STAGING
    </p>
  );
}
