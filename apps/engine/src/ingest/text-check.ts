import type { IngestError } from "@taskville/protocol";

/**
 * Per-event text check before hashing: canonical JSON (and so the content hash)
 * refuses lone surrogates, and walking an absurdly deep value overflows the
 * stack. Either is reported as this one event's rejection, never as a thrown
 * error that would roll back the whole batch (security review F2).
 */
export function textProblem(event: unknown): IngestError | undefined {
  let path: string | undefined;
  try {
    path = illFormedPath(event);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { code: "invalid_payload", path: "payload", message: "Payload is nested too deeply" };
  }
  if (path === undefined) return undefined;
  return {
    code: path.startsWith("payload.") ? "invalid_payload" : "invalid_envelope",
    path,
    message: "Text must be well-formed Unicode (no lone surrogates)",
  };
}

/** Dotted path of the first string (or key) that is not well-formed UTF-16, if any. */
function illFormedPath(value: unknown, path = ""): string | undefined {
  if (typeof value === "string") return value.isWellFormed() ? undefined : path;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = illFormedPath(value[i], path === "" ? `${i}` : `${path}.${i}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const here = path === "" ? key : `${path}.${key}`;
      if (!key.isWellFormed()) return here;
      const found = illFormedPath(item, here);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
