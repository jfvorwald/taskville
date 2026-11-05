import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWebDir } from "@taskville/engine/src/config/web-dir.ts";
import type { ProjectsResponse } from "@taskville/protocol";
import { readToken } from "../client.ts";
import { type Context, type DoctorProbes, discoverUrl, type Io, parseCommand } from "../context.ts";
import { EXIT } from "../errors.ts";
import { isTaskvilleHook, SHIM_NAME, shellQuote } from "./install-settings.ts";

const USAGE = "taskville doctor [--json] [--home <dir>] [--url <base>]";
const REPO_PACKAGE = fileURLToPath(new URL("../../../../package.json", import.meta.url));
const FALLBACK_ENGINES = ">=26.8.2 <27";

export interface Check {
  id: string;
  status: "ok" | "warn" | "fail";
  message: string;
  fix?: string;
}

const ok = (id: string, message: string): Check => ({ id, status: "ok", message });
const fail = (id: string, message: string, fix: string): Check => ({
  id,
  status: "fail",
  message,
  fix,
});

function realProbes(context: Context): DoctorProbes {
  return {
    nodeVersion: process.versions.node,
    webClientBuilt: () => resolveWebDir(context.io.env).dir !== undefined,
    engineHealthy: async (url) => {
      let token: string | undefined;
      try {
        token = readToken(context.home);
      } catch {
        token = undefined; // Probe anyway: no answer must not be reported as a token problem.
      }
      try {
        const response = await fetch(`${url}/health`, {
          ...(token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } }),
          signal: AbortSignal.timeout(2000),
        });
        if (response.status === 401 || response.status === 403) return "unauthorized";
        return response.ok;
      } catch {
        return false;
      }
    },
    onPath: (command) =>
      (context.io.env.PATH ?? process.env.PATH ?? "").split(delimiter).some((dir) => {
        try {
          accessSync(join(dir, command), constants.X_OK);
          return true;
        } catch {
          return false;
        }
      }),
    listProjects: async () =>
      (await context.client().json<ProjectsResponse>("GET", "/v1/projects")).projects,
  };
}

const parts = (version: string): number[] => version.split(".").map((n) => Number.parseInt(n, 10));
function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The engines.node range of this repository, as the minimum and the exclusive maximum. */
function enginesRange(): { text: string; min: number[]; max: number[] } {
  let text = FALLBACK_ENGINES;
  try {
    const engines = (
      JSON.parse(readFileSync(REPO_PACKAGE, "utf8")) as { engines?: { node?: string } }
    ).engines?.node;
    if (typeof engines === "string") text = engines;
  } catch {
    // Installed without the repository's package.json: use the range this release was built for.
  }
  const min = /(?:>=)\s*(\d+(?:\.\d+){0,2})/.exec(text)?.[1] ?? "0";
  const max = /<\s*(\d+(?:\.\d+){0,2})/.exec(text)?.[1] ?? "9999";
  return { text, min: parts(min), max: parts(max) };
}

function checkNode(version: string): Check {
  const range = enginesRange();
  const v = parts(version);
  if (compare(v, range.min) >= 0 && compare(v, range.max) < 0) {
    return ok("node", `Node ${version}`);
  }
  const major = range.min[0] ?? 26;
  return fail(
    "node",
    `Node ${version} is outside ${range.text}`,
    `install Node ${major} (for example: nvm install ${major})`,
  );
}

type Settings = { hooks?: Record<string, { hooks?: unknown[] }[]> };

function readJson(path: string): Settings | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Settings;
  } catch {
    return undefined;
  }
}

/** True when some Taskville hook in the file names this Taskville home and engine URL. */
function hooksMatch(settings: Settings | undefined, home: string, url: string): boolean {
  const wantHome = `TASKVILLE_HOME=${shellQuote(home)} `;
  const wantUrl = `TASKVILLE_URL=${shellQuote(url)} `;
  const groups = Object.values(settings?.hooks ?? {}).flat();
  return groups.some((group) =>
    (Array.isArray(group?.hooks) ? group.hooks : []).some((handler) => {
      if (!isTaskvilleHook(handler)) return false;
      const command = (handler as { command: string }).command;
      return command.includes(wantHome) && command.includes(wantUrl);
    }),
  );
}

function checkHooks(io: Io, home: string, url: string): Check {
  const configDir = io.env.CLAUDE_CONFIG_DIR;
  const userDir =
    configDir !== undefined && configDir !== ""
      ? configDir
      : io.env.HOME === undefined || io.env.HOME === ""
        ? undefined
        : join(io.env.HOME, ".claude");
  const user = userDir === undefined ? undefined : readJson(join(userDir, "settings.json"));
  if (hooksMatch(user, home, url)) return ok("hooks", `installed in user settings for ${url}`);
  // Project settings live at the project root; look in this folder and each parent.
  for (let dir = resolve(io.cwd); ; dir = dirname(dir)) {
    const project = readJson(join(dir, ".claude", "settings.local.json"));
    if (hooksMatch(project, home, url))
      return ok("hooks", `installed in project settings for ${url}`);
    if (dirname(dir) === dir) break;
  }
  return fail(
    "hooks",
    `no Claude Code hooks point at ${home} and ${url}`,
    "taskville install claude-code --scope user  (or --scope project)",
  );
}

function checkShim(home: string): Check {
  const shim = join(home, "hooks", SHIM_NAME);
  try {
    if ((statSync(shim).mode & 0o111) !== 0) return ok("shim", shim);
    return fail("shim", `${shim} is not executable`, "taskville install claude-code --scope user");
  } catch {
    return fail("shim", `${shim} is missing`, "taskville install claude-code --scope user");
  }
}

async function checkProject(io: Io, probes: DoctorProbes): Promise<Check> {
  const here = [io.cwd];
  try {
    here.push(realpathSync(io.cwd));
  } catch {
    // The folder is gone or unreadable: compare the path as given.
  }
  try {
    const found = (await probes.listProjects()).find((p) =>
      p.roots.some((root) => here.some((d) => d === root || d.startsWith(root + sep))),
    );
    if (found !== undefined) return ok("project", `${found.name} (${found.id})`);
    return fail("project", "this folder is not in any project", "taskville init");
  } catch {
    return fail("project", "could not list projects", "taskville start");
  }
}

/** `taskville doctor`: one line per check, with the command that fixes a failing one (M7.10). */
export async function doctor(io: Io, args: string[]): Promise<number> {
  const { values, context } = parseCommand(io, args, {}, USAGE);
  const probes: DoctorProbes = { ...realProbes(context), ...io.doctor };
  const checks: Check[] = [checkNode(probes.nodeVersion)];

  checks.push(
    probes.webClientBuilt()
      ? ok("web", "web client is built")
      : fail(
          "web",
          "web client is not built",
          "pnpm bootstrap  (or: pnpm --filter @taskville/web build)",
        ),
  );

  const asked = (values.url as string | undefined) ?? io.env.TASKVILLE_URL;
  const engineUrl = asked ?? discoverUrl(io, context.home);
  const health = engineUrl === undefined ? false : await probes.engineHealthy(engineUrl);
  if (health === true) {
    checks.push(ok("engine", `running at ${engineUrl}`));
  } else if (health === "unauthorized") {
    checks.push(
      fail(
        "engine",
        `the engine at ${engineUrl} rejected the token in ${context.home}`,
        "taskville start  (use the same --home as the running engine)",
      ),
    );
  } else {
    checks.push(
      fail(
        "engine",
        engineUrl === undefined ? "no engine is running" : `no answer from ${engineUrl}`,
        "taskville start",
      ),
    );
  }

  checks.push(checkHooks(io, context.home, engineUrl ?? context.url));
  checks.push(checkShim(context.home));
  checks.push(
    probes.onPath("curl")
      ? ok("curl", "curl is on PATH")
      : fail(
          "curl",
          "curl is not on PATH; the hook shim needs it",
          "install curl with your package manager",
        ),
  );
  checks.push(await checkProject(io, probes));

  if (context.json) {
    io.stdout(`${JSON.stringify(checks, null, 2)}\n`);
  } else {
    for (const c of checks) {
      io.stdout(`${c.status} ${c.id}: ${c.message}\n`);
      if (c.fix !== undefined) io.stdout(`      fix: ${c.fix}\n`);
    }
  }
  return checks.some((c) => c.status === "fail") ? EXIT.failure : EXIT.ok;
}
