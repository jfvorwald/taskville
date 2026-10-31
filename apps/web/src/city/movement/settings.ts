import { useEffect, useState } from "react";
import { type ActivityAreaTable, resolveActivityAreas } from "./areas.ts";

/** Local override of the activity-to-area table (JSON, see `resolveActivityAreas`). */
export const AREA_OVERRIDES_KEY = "taskville.activityAreas";

/** The table with any stored overrides applied. Broken or blocked storage gives the defaults. */
export function loadActivityAreas(storage: Pick<Storage, "getItem"> | null): ActivityAreaTable {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(AREA_OVERRIDES_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw === null) return resolveActivityAreas(undefined);
  try {
    return resolveActivityAreas(JSON.parse(raw));
  } catch {
    return resolveActivityAreas(undefined);
  }
}

const QUERY = "(prefers-reduced-motion: reduce)";

/** The system reduced-motion preference, live. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === "function" && matchMedia(QUERY).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia(QUERY);
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}
