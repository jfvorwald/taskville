import { realpath as fsRealpath } from "node:fs/promises";
import { posix } from "node:path";
import { UNSORTED_PROJECT_ID } from "../../storage/index.ts";

/** The parts of a project record that routing needs. */
export interface RoutableProject {
  id: string;
  roots: readonly string[];
  builtin: boolean;
}

export interface ResolveOptions {
  /** Real path lookup, injectable for tests. Defaults to `fs.promises.realpath`. */
  realpath?: (path: string) => Promise<string>;
}

/** PATH_MAX on Linux; a longer `cwd` is not a real working directory. */
export const MAX_CWD_LENGTH = 4096;
// C0 controls (including NUL) and DEL never appear in a real working directory.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Normalizes an absolute POSIX path: resolves `.` and `..` (never above `/`),
 * collapses repeated slashes, and drops a trailing slash. Returns undefined
 * for anything that is not a usable absolute path.
 */
function normalizeAbsolute(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  if (path.length === 0 || path.length > MAX_CWD_LENGTH) return undefined;
  if (!path.isWellFormed() || CONTROL.test(path) || !path.startsWith("/")) return undefined;
  const normalized = posix.normalize(path);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/** True when `path` is `root` or lies below it, on whole path segments (`/repo-evil` is not under `/repo`). */
function isWithin(path: string, root: string): boolean {
  if (path === root) return true;
  return path.startsWith(root === "/" ? "/" : `${root}/`);
}

interface Candidate {
  id: string;
  root: string;
}

function candidates(projects: readonly RoutableProject[]): Candidate[] {
  const out: Candidate[] = [];
  for (const project of projects) {
    // The built-in Unsorted project is the fallback, never a match.
    if (project.builtin) continue;
    for (const raw of project.roots) {
      const root = normalizeAbsolute(raw);
      if (root !== undefined) out.push({ id: project.id, root });
    }
  }
  return out;
}

/** Longest matching root wins; equal roots go to the smallest project ID, so order never matters. */
function bestMatch(path: string, roots: readonly Candidate[]): string | undefined {
  let best: Candidate | undefined;
  for (const candidate of roots) {
    if (!isWithin(path, candidate.root)) continue;
    if (
      best === undefined ||
      candidate.root.length > best.root.length ||
      (candidate.root.length === best.root.length && candidate.id < best.id)
    ) {
      best = candidate;
    }
  }
  return best?.id;
}

/**
 * Lexical routing only: the project whose configured root contains `cwd`
 * after normalizing both, or undefined. No file system access.
 */
export function matchProjectRoot(
  cwd: string,
  projects: readonly RoutableProject[],
): string | undefined {
  const path = normalizeAbsolute(cwd);
  return path === undefined ? undefined : bestMatch(path, candidates(projects));
}

/**
 * Resolves the project for a hook's working directory (ARCHITECTURE.md 8.1).
 * `cwd` is untrusted input: anything that is not a well-formed absolute path
 * of at most 4,096 characters without control characters goes to Unsorted.
 *
 * Symlinks: the path as Claude Code reported it is matched first, lexically,
 * against the normalized configured roots. Only when that matches nothing are
 * real paths consulted (the `cwd`'s and each root's), so a root configured
 * through a symlink, or a `cwd` reported through one (macOS `/tmp` versus
 * `/private/tmp`), still routes. A path that cannot be resolved, for example
 * a folder deleted before a spooled event is replayed, falls back to Unsorted.
 * Matching is case-sensitive, also on case-insensitive file systems.
 */
export async function resolveProjectId(
  cwd: unknown,
  projects: readonly RoutableProject[],
  options: ResolveOptions = {},
): Promise<string> {
  const path = normalizeAbsolute(cwd);
  if (path === undefined) return UNSORTED_PROJECT_ID;
  const roots = candidates(projects);
  const lexical = bestMatch(path, roots);
  if (lexical !== undefined) return lexical;
  if (roots.length === 0) return UNSORTED_PROJECT_ID;

  const realpath = options.realpath ?? fsRealpath;
  const real = async (p: string) => normalizeAbsolute(await realpath(p).catch(() => undefined));
  const realRoots = await Promise.all(
    roots.map(async ({ id, root }) => {
      const resolved = await real(root);
      return resolved === undefined ? undefined : { id, root: resolved };
    }),
  );
  const expanded = [...roots, ...realRoots.filter((r): r is Candidate => r !== undefined)];
  const viaRealRoot = bestMatch(path, expanded);
  if (viaRealRoot !== undefined) return viaRealRoot;
  const realCwd = await real(cwd as string);
  return (realCwd === undefined ? undefined : bestMatch(realCwd, expanded)) ?? UNSORTED_PROJECT_ID;
}
