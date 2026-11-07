import { useEffect, useState } from "react";
import { useOptionalSession } from "../pairing/session.tsx";

/** What the engine reports about the running build on `/health`. */
export interface ReleaseIdentity {
  id: string;
  version?: string;
  environment: "development" | "staging" | "production";
}

const ENVIRONMENTS: readonly string[] = ["development", "staging", "production"];
const SHORT_ID_LENGTH = 12;
const SESSION_HEADER = "X-Taskville-Session";

/** The `release` block of a `/health` body, or null for anything else (an older engine, junk). */
export function parseRelease(body: unknown): ReleaseIdentity | null {
  if (typeof body !== "object" || body === null || !("release" in body)) return null;
  const release = body.release;
  if (typeof release !== "object" || release === null) return null;
  const { id, version, environment } = release as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return null;
  if (typeof environment !== "string" || !ENVIRONMENTS.includes(environment)) return null;
  return {
    id,
    ...(typeof version === "string" ? { version } : {}),
    environment: environment as ReleaseIdentity["environment"],
  };
}

/** A long id (a commit hash) shortened to a stable prefix. */
export function shortReleaseId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

/** One call to `/health` for the release identity. Null on any failure; the header just shows nothing. */
export async function fetchRelease(
  fetchFn: typeof fetch,
  secret: string,
): Promise<ReleaseIdentity | null> {
  try {
    const response = await fetchFn("/health", { headers: { [SESSION_HEADER]: secret } });
    if (!response.ok) return null;
    return parseRelease(await response.json());
  } catch {
    return null;
  }
}

/** The release identity, fetched once when the page is paired. Null until known, or when unpaired. */
export function useRelease(): ReleaseIdentity | null {
  const secret = useOptionalSession();
  const [release, setRelease] = useState<ReleaseIdentity | null>(null);
  useEffect(() => {
    if (secret === null) return;
    let live = true;
    void fetchRelease(fetch, secret).then((found) => {
      if (live) setRelease(found);
    });
    return () => {
      live = false;
    };
  }, [secret]);
  return release;
}
