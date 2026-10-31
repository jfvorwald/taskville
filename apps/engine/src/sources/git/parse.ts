// Parses the output of the two read-only git commands the watcher runs.

/** A full object name: SHA-1 (40) or SHA-256 (64) lowercase hex. */
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const isSha = (value: string): boolean => SHA.test(value);

/** Unix seconds as an ISO timestamp, or undefined unless a sane whole number (L-39). */
export function unixToIso(text: string): string | undefined {
  if (!/^\d{1,12}$/.test(text)) return undefined;
  const ms = Number(text) * 1000;
  return Number.isSafeInteger(ms) && ms <= 8.64e15 ? new Date(ms).toISOString() : undefined;
}

export interface RefTip {
  ref: string;
  sha: string;
  /** Committer date of the commit the ref points at. */
  committedAt: string;
}

/** `for-each-ref` fields, tab-separated (ref names cannot contain control characters). */
export const REF_FORMAT = "%(objectname)%09%(committerdate:unix)%09%(symref)%09%(refname)";

/**
 * Branch tips from `for-each-ref --format=REF_FORMAT`. Symbolic refs (`origin/HEAD`) and lines
 * that do not parse are skipped. At most `limit` refs, in git's order (sorted by name).
 */
export function parseRefs(output: string, limit: number): RefTip[] {
  const tips: RefTip[] = [];
  for (const line of output.split("\n")) {
    if (tips.length >= limit) break;
    const [sha, date, symref, ref, ...rest] = line.split("\t");
    if (rest.length > 0 || sha === undefined || ref === undefined || ref === "") continue;
    if (symref !== "" || !isSha(sha)) continue;
    const committedAt = unixToIso(date ?? "");
    if (committedAt === undefined) continue;
    tips.push({ ref, sha, committedAt });
  }
  return tips;
}

export interface CommitRecord {
  sha: string;
  parents: string[];
  committedAt: string;
  subject: string;
}

/** `log -z` fields, unit-separated. The subject is last, so a separator inside it is kept. */
export const LOG_FORMAT = "%H%x1f%P%x1f%ct%x1f%s";

/** Commits from `log -z --format=LOG_FORMAT`, newest first as git prints them. */
export function parseLog(output: string): CommitRecord[] {
  const commits: CommitRecord[] = [];
  for (const record of output.split("\0")) {
    const fields = record.replace(/^\n/, "").split("\x1f");
    if (fields.length < 4) continue;
    const [sha = "", parentText = "", date = ""] = fields;
    const parents = parentText === "" ? [] : parentText.split(" ");
    const committedAt = unixToIso(date);
    if (!isSha(sha) || !parents.every(isSha) || committedAt === undefined) continue;
    commits.push({ sha, parents, committedAt, subject: fields.slice(3).join("\x1f") });
  }
  return commits;
}
