import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ACTIVITIES, type Activity } from "@taskville/protocol";
import { z } from "zod";
import { expandTilde } from "./home.ts";
import { openerIssues } from "./opener.ts";

export const DEFAULT_PORT = 4807;
/**
 * Spike S-1 recommendation (decision #116, D1; the owner decides at G1): hold a
 * PermissionRequest for 90 s, and set the hook's own timeout 5 s above that so
 * the engine always answers before Claude Code gives up on the hook.
 */
export const DEFAULT_HOLD_WINDOW_SECONDS = 90;
export const HOOK_TIMEOUT_MARGIN_SECONDS = 5;
export const MAX_HOLD_WINDOW_SECONDS = 300;
export const UNSORTED_PROJECT_ID = "unsorted";

/** City work areas (ARCHITECTURE.md 2.1, 8.3). */
export const WORK_AREAS = [
  "dispatch",
  "workshop",
  "test_lab",
  "review",
  "security",
  "archives",
] as const;
export type WorkArea = (typeof WORK_AREAS)[number];
export type WorkAreaMap = Partial<Record<Activity, WorkArea>>;

/** ARCHITECTURE.md 8.3. Agent-type rules (reviewer and security subagents) live in the domain, not here. */
export const DEFAULT_WORK_AREAS: Readonly<WorkAreaMap> = Object.freeze({
  dispatching: "dispatch",
  implementing: "workshop",
  testing: "test_lab",
  reviewing: "review",
  researching: "archives",
  documenting: "archives",
});

export interface ProjectConfig {
  id: string;
  name: string;
  /** Absolute, normalized repository folders. */
  roots: string[];
}

export interface TaskvilleConfig {
  port: number;
  /** Projects to register at engine start when absent (decision #110). Never includes Unsorted. */
  projects: ProjectConfig[];
  /** `execFile` template, or null for copy-only Open session. */
  sessionOpener: string[] | null;
  workAreas: WorkAreaMap;
  bridge: { holdWindowSeconds: number; hookTimeoutSeconds: number };
}

export interface ParseContext {
  /** `--port` from the CLI; beats the file. */
  port?: number | undefined;
  homedir?: string;
  /** Whether a root exists as a folder; a missing root is a warning, not an error. */
  rootExists?: (path: string) => boolean;
}

export interface LoadedConfig {
  config: TaskvilleConfig;
  warnings: string[];
}

/** Invalid configuration. `issues` are `path: problem` lines; the message adds the file path. */
export class ConfigError extends Error {
  override name = "ConfigError";
  readonly issues: string[];

  constructor(issues: string[], source?: string) {
    const lines = issues.map((issue) => (source === undefined ? issue : `${source}: ${issue}`));
    super(`Invalid Taskville configuration:\n${lines.join("\n")}`);
    this.issues = issues;
  }
}

const TOP_LEVEL_KEYS = ["port", "projects", "sessionOpener", "workAreas", "bridge"] as const;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PORT_RANGE = "must be a whole number from 1024 to 65535";
const HOLD_RANGE = `must be a whole number of seconds from 1 to ${MAX_HOLD_WINDOW_SECONDS}`;

const Port = z
  .int({ error: PORT_RANGE })
  .min(1024, { error: PORT_RANGE })
  .max(65535, { error: PORT_RANGE });

const Project = z.strictObject({
  id: z
    .string({ error: "must be a string" })
    .regex(PROJECT_ID, {
      error:
        "must be 1 to 63 lowercase letters, digits, or hyphens, starting with a letter or digit",
    })
    .optional(),
  name: z
    .string({ error: "must be a string" })
    .trim()
    .min(1, { error: "must not be empty" })
    .max(100, { error: "must be at most 100 characters" }),
  roots: z
    .array(z.string({ error: "must be a string" }).min(1, { error: "must not be empty" }), {
      error: "must be an array of repository folder paths",
    })
    .min(1, { error: "must list at least one repository folder" }),
});

const Shape = z.object({
  port: Port.optional(),
  projects: z.array(Project, { error: "must be an array of projects" }).optional(),
  sessionOpener: z.unknown().optional(),
  workAreas: z.unknown().optional(),
  bridge: z
    .strictObject(
      {
        holdWindowSeconds: z
          .int({ error: HOLD_RANGE })
          .min(1, { error: HOLD_RANGE })
          .max(MAX_HOLD_WINDOW_SECONDS, { error: HOLD_RANGE })
          .optional(),
      },
      { error: "must be an object" },
    )
    .optional(),
});

/** Validates raw config (parsed JSON) and applies defaults. Throws ConfigError listing every problem. */
export function parseConfig(raw: unknown, ctx: ParseContext = {}): LoadedConfig {
  const homedir = ctx.homedir ?? osHomedir();
  const rootExists = ctx.rootExists ?? isDirectory;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(["config must be a JSON object"]);
  }

  const issues: string[] = [];
  const warnings: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      issues.push(`${key}: unknown setting; allowed settings are ${TOP_LEVEL_KEYS.join(", ")}`);
    }
  }

  const parsed = Shape.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      issues.push(`${formatPath(issue.path)}: ${issue.message}`);
  }
  const data = parsed.success ? parsed.data : undefined;
  const input = raw as Record<string, unknown>;

  let port = data?.port ?? DEFAULT_PORT;
  if (ctx.port !== undefined) {
    if (Port.safeParse(ctx.port).success) port = ctx.port;
    else issues.push(`--port: ${PORT_RANGE}`);
  }

  const projects = data?.projects
    ? checkProjects(data.projects, homedir, rootExists, issues, warnings)
    : [];

  let sessionOpener: string[] | null = null;
  if (input.sessionOpener !== undefined && input.sessionOpener !== null) {
    const found = openerIssues(input.sessionOpener);
    for (const { index, message } of found) {
      issues.push(`sessionOpener${index === undefined ? "" : `[${index}]`}: ${message}`);
    }
    if (found.length === 0) sessionOpener = [...(input.sessionOpener as string[])];
  }

  const workAreas = checkWorkAreas(input.workAreas, issues);

  if (issues.length > 0) throw new ConfigError(issues);

  const holdWindowSeconds = data?.bridge?.holdWindowSeconds ?? DEFAULT_HOLD_WINDOW_SECONDS;
  return {
    config: {
      port,
      projects,
      sessionOpener,
      workAreas,
      bridge: {
        holdWindowSeconds,
        hookTimeoutSeconds: holdWindowSeconds + HOOK_TIMEOUT_MARGIN_SECONDS,
      },
    },
    warnings,
  };
}

/**
 * Reads `<home>/config.json` (defaults if absent) and validates it. Refuses a
 * file another user owns or that group or others can write, because the file
 * names a program the engine runs (the session opener).
 */
export function loadConfig(options: {
  home: string;
  port?: number | undefined;
  homedir?: string;
}): LoadedConfig {
  const path = join(options.home, "config.json");
  const text = readConfigText(path);
  if (text === undefined) return parseConfig({}, { port: options.port, ...homedirOption(options) });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError([`not valid JSON (${(err as Error).message})`], path);
  }
  try {
    return parseConfig(raw, { port: options.port, ...homedirOption(options) });
  } catch (err) {
    if (err instanceof ConfigError) throw new ConfigError(err.issues, path);
    throw err;
  }
}

function homedirOption(options: { homedir?: string }): { homedir?: string } {
  return options.homedir === undefined ? {} : { homedir: options.homedir };
}

function readConfigText(path: string): string | undefined {
  let fd: number;
  try {
    // Non-blocking so a FIFO at this path cannot hang startup.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError([`cannot read the config file (${(err as Error).message})`], path);
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new ConfigError(["is not a regular file"], path);
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid)
      throw new ConfigError(["is owned by another user"], path);
    if ((stats.mode & 0o022) !== 0) {
      throw new ConfigError([`is writable by group or others; run: chmod 600 ${path}`], path);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

type RawProject = z.infer<typeof Project>;

function checkProjects(
  raw: RawProject[],
  homedir: string,
  rootExists: (path: string) => boolean,
  issues: string[],
  warnings: string[],
): ProjectConfig[] {
  const projects: ProjectConfig[] = [];
  const idOwner = new Map<string, number>();
  const rootOwner = new Map<string, number>();
  raw.forEach((project, i) => {
    const at = `projects[${i}]`;
    const id = project.id ?? slugify(project.name);
    if (id === "") {
      issues.push(`${at}.name: cannot derive an ID from "${project.name}"; add an "id"`);
    } else if (id === UNSORTED_PROJECT_ID) {
      issues.push(`${at}: ID "${id}" is the built-in Unsorted project; choose another name or id`);
    } else if (idOwner.has(id)) {
      issues.push(`${at}.id: "${id}" is already used by projects[${idOwner.get(id)}]`);
    } else {
      idOwner.set(id, i);
    }
    const roots: string[] = [];
    project.roots.forEach((rawRoot, j) => {
      const where = `${at}.roots[${j}]`;
      const expanded = expandTilde(rawRoot, homedir);
      if (!isAbsolute(expanded)) {
        issues.push(`${where}: must be an absolute path (got "${rawRoot}")`);
        return;
      }
      const root = resolve(expanded);
      const owner = rootOwner.get(root);
      if (owner !== undefined) {
        issues.push(`${where}: "${root}" is already a root of projects[${owner}]`);
        return;
      }
      rootOwner.set(root, i);
      if (!rootExists(root)) warnings.push(`${where}: "${root}" does not exist or is not a folder`);
      roots.push(root);
    });
    projects.push({ id, name: project.name, roots });
  });
  return projects;
}

function checkWorkAreas(raw: unknown, issues: string[]): WorkAreaMap {
  const merged: WorkAreaMap = { ...DEFAULT_WORK_AREAS };
  if (raw === undefined) return merged;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push('workAreas: must be an object like { "testing": "test_lab" }');
    return merged;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!(ACTIVITIES as readonly string[]).includes(key)) {
      issues.push(`workAreas.${key}: unknown activity; use one of ${ACTIVITIES.join(", ")}`);
      continue;
    }
    if (typeof value !== "string" || !(WORK_AREAS as readonly string[]).includes(value)) {
      issues.push(
        `workAreas.${key}: unknown work area ${JSON.stringify(value)}; use one of ${WORK_AREAS.join(", ")}`,
      );
      continue;
    }
    merged[key as Activity] = value as WorkArea;
  }
  return merged;
}

/** Lowercase ASCII slug used as the default project ID (matches `POST /v1/projects`). */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

function formatPath(path: readonly PropertyKey[]): string {
  return path
    .map((part, i) =>
      typeof part === "number" ? `[${part}]` : `${i === 0 ? "" : "."}${String(part)}`,
    )
    .join("");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
