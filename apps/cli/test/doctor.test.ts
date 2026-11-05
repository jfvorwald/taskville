import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cli, freePort, startServe, tempDir } from "./helpers.ts";

// M7.10 (#382): `taskville doctor`. Red-phase tests.
//
// New command src/commands/doctor.ts, registered in main.ts:
//   taskville doctor [--json] [--home <dir>] [--url <base>]
// One output line per check, in this order, shaped `<status> <id>: <message>` where status is
// ok | warn | fail and id is one of: node, web, engine, hooks, shim, curl, project. A failing
// line is followed by its fix on its own line, indented six spaces: `      fix: <command>`. Exit 0 when no check failed
// (warn is fine), 1 when any failed. `--json` prints a JSON array of
// { id, status, message, fix? } (fix present on fail) instead of lines.
//
// Seam: an optional `io.doctor?: DoctorProbes` (field on Io in src/context.ts). main.ts fills
// the real probes; every probe the tests omit must fall back to the real one, so tests inject
// all of them. Probes:
//   nodeVersion: string                           e.g. "26.8.2"; checked against the repo
//                                                 package.json engines.node (">=26.8.2 <27")
//   webClientBuilt(): boolean
//   engineHealthy(url: string): Promise<boolean>  GET /health answered
//   onPath(command: string): boolean              "curl" lookup
//   listProjects(): Promise<{ id: string; name: string; roots: string[] }[]>
// Everything else is real but sandboxed: engine.json in a temp Taskville home plus
// `io.isAlive` (existing seam) for the engine URL (discovery), the shim is the real file that
// `taskville install claude-code` copies into the temp home, and hooks are read from real
// settings files in a temp HOME (user scope) and the temp project directory (project scope),
// written by the real install command. The cwd is the project directory.
// Check rules:
//   node:    ok when nodeVersion satisfies engines (fix names Node 26); fail otherwise
//   web:     fail -> fix mentions pnpm (pnpm bootstrap or the web build)
//   engine:  ok message contains the discovered URL; fail -> fix is `taskville start`
//   hooks:   ok when user OR project settings hold Taskville hooks whose command names this
//            Taskville home and the engine URL; fail when none do, or they name another home
//            or URL -> fix is `taskville install claude-code --scope user|project`
//   shim:    ok when <home>/hooks/taskville-claude-code-shim.sh exists and is executable
//   curl:    ok when onPath("curl"); fail -> fix mentions curl
//   project: ok when some project root equals or contains the cwd; fail -> fix `taskville init`

const dirs: { remove: () => void }[] = [];
afterAll(() => {
  for (const d of dirs) d.remove();
});

const URL_OK = "http://127.0.0.1:4999";

type Probes = {
  nodeVersion: string;
  webClientBuilt: () => boolean;
  engineHealthy: (url: string) => Promise<boolean>;
  onPath: (command: string) => boolean;
  listProjects: () => Promise<{ id: string; name: string; roots: string[] }[]>;
};

async function healthy(opts: { hooks?: "user" | "project" | "none" | "other-home" } = {}) {
  const dir = tempDir("taskville-doctor-");
  dirs.push(dir);
  const root = realpathSync(dir.path);
  const home = join(root, "home");
  const tv = join(home, ".taskville");
  const project = join(root, "project");
  for (const p of [home, tv, project]) mkdirSync(p, { recursive: true });
  writeFileSync(
    join(tv, "engine.json"),
    JSON.stringify({ url: URL_OK, pid: 4242, startedAt: "2026-11-04T10:00:00.000Z" }),
  );
  const hooks = opts.hooks ?? "user";
  if (hooks !== "none") {
    const scope = hooks === "project" ? "project" : "user";
    const installHome = hooks === "other-home" ? join(root, "elsewhere") : tv;
    const r = await cli(
      ["install", "claude-code", "--scope", scope, "--yes", "--home", installHome, "--url", URL_OK],
      { env: { HOME: home }, cwd: project },
    );
    if (r.code !== 0) throw new Error(`install failed: ${r.stderr}`);
  }
  const probes: Probes = {
    nodeVersion: "26.8.2",
    webClientBuilt: () => true,
    engineHealthy: async () => true,
    onPath: () => true,
    listProjects: async () => [{ id: "p1", name: "project", roots: [project] }],
  };
  const run = (extra: string[] = [], over: Partial<Probes> = {}, cwd = project) =>
    cli(["doctor", ...extra, "--home", tv], {
      env: { HOME: home },
      cwd,
      isAlive: (pid: number) => pid === 4242,
      doctor: { ...probes, ...over },
    } as Parameters<typeof cli>[1]);
  return { root, home, tv, project, run };
}

const line = (stdout: string, id: string) => {
  const rows = stdout.split("\n");
  const at = rows.findIndex((l) => new RegExp(`^(ok|warn|fail)\\s+${id}\\b`).test(l));
  if (at < 0) return undefined;
  // The check line, plus its fix line when the next line is indented.
  return /^\s+\S/.test(rows[at + 1] ?? "") ? `${rows[at]}\n${rows[at + 1]}` : rows[at];
};

describe("taskville doctor", () => {
  it("prints one ok line per check in order and exits 0 when everything is fine", async () => {
    const sb = await healthy();
    const r = await sb.run();
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines.map((l) => /^(ok|warn|fail)\s+(\w+)/.exec(l)?.[2])).toEqual([
      "node",
      "web",
      "engine",
      "hooks",
      "shim",
      "curl",
      "project",
    ]);
    for (const l of lines) expect(l).toMatch(/^ok /);
  });

  it("--json prints the checks as an array", async () => {
    const sb = await healthy();
    const r = await sb.run(["--json"]);
    expect(r.code).toBe(0);
    const checks = JSON.parse(r.stdout) as { id: string; status: string; message: string }[];
    expect(checks.map((c) => c.id)).toEqual([
      "node",
      "web",
      "engine",
      "hooks",
      "shim",
      "curl",
      "project",
    ]);
    expect(checks.every((c) => c.status === "ok" && typeof c.message === "string")).toBe(true);
  });

  it("--json includes the fix on a failing check and exits 1", async () => {
    const sb = await healthy();
    const r = await sb.run(["--json"], { onPath: () => false });
    expect(r.code).toBe(1);
    const curl = (JSON.parse(r.stdout) as { id: string; status: string; fix?: string }[]).find(
      (c) => c.id === "curl",
    );
    expect(curl?.status).toBe("fail");
    expect(curl?.fix).toMatch(/curl/);
  });

  it("node: fails outside the engines range, with the fix on the line", async () => {
    const sb = await healthy();
    for (const version of ["25.9.0", "26.8.1", "27.0.0"]) {
      const r = await sb.run([], { nodeVersion: version });
      expect(r.code).toBe(1);
      expect(line(r.stdout, "node")).toMatch(/^fail node/);
      expect(line(r.stdout, "node")).toMatch(/\n {6}fix:.*26/);
    }
    const ok = await sb.run([], { nodeVersion: "26.9.0" });
    expect(line(ok.stdout, "node")).toMatch(/^ok node/);
  });

  it("web: fails when the client is not built", async () => {
    const sb = await healthy();
    const r = await sb.run([], { webClientBuilt: () => false });
    expect(r.code).toBe(1);
    expect(line(r.stdout, "web")).toMatch(/^fail web[^\n]*\n {6}fix:.*pnpm/);
  });

  it("engine: ok names the discovered URL", async () => {
    const sb = await healthy();
    const r = await sb.run();
    expect(line(r.stdout, "engine")).toMatch(/^ok engine/);
    expect(line(r.stdout, "engine")).toContain(URL_OK);
  });

  it("engine: fails with `taskville start` when nothing is running or it does not answer", async () => {
    const sb = await healthy();
    const dead = await cli(["doctor", "--home", sb.tv], {
      env: { HOME: sb.home },
      cwd: sb.project,
      isAlive: () => false,
      doctor: {
        nodeVersion: "26.8.2",
        webClientBuilt: () => true,
        engineHealthy: async () => false,
        onPath: () => true,
        listProjects: async () => [],
      },
    } as Parameters<typeof cli>[1]);
    expect(dead.code).toBe(1);
    expect(line(dead.stdout, "engine")).toMatch(/^fail engine[^\n]*\n {6}fix:.*taskville start/);

    const silent = await sb.run([], { engineHealthy: async () => false });
    expect(silent.code).toBe(1);
    expect(line(silent.stdout, "engine")).toMatch(/^fail engine[^\n]*\n {6}fix:.*taskville start/);
  });

  it("hooks: ok from user scope and from project scope", async () => {
    for (const hooks of ["user", "project"] as const) {
      const sb = await healthy({ hooks });
      const r = await sb.run();
      expect(line(r.stdout, "hooks"), hooks).toMatch(/^ok hooks/);
    }
  });

  it("hooks: fails when none are installed, with the install command as the fix", async () => {
    const sb = await healthy({ hooks: "none" });
    const r = await sb.run();
    expect(r.code).toBe(1);
    expect(line(r.stdout, "hooks")).toMatch(
      /^fail hooks[^\n]*\n {6}fix:.*taskville install claude-code/,
    );
  });

  it("hooks: fails when they point at another Taskville home", async () => {
    const sb = await healthy({ hooks: "other-home" });
    const r = await sb.run();
    expect(line(r.stdout, "hooks")).toMatch(
      /^fail hooks[^\n]*\n {6}fix:.*taskville install claude-code/,
    );
  });

  it("shim: fails when missing or not executable, ok otherwise", async () => {
    const sb = await healthy();
    const shim = join(sb.tv, "hooks", "taskville-claude-code-shim.sh");
    chmodSync(shim, 0o644);
    const noexec = await sb.run();
    expect(noexec.code).toBe(1);
    expect(line(noexec.stdout, "shim")).toMatch(
      /^fail shim[^\n]*\n {6}fix:.*taskville install claude-code/,
    );
    rmSync(shim);
    const missing = await sb.run();
    expect(line(missing.stdout, "shim")).toMatch(/^fail shim/);
    const fresh = await healthy();
    expect(line((await fresh.run()).stdout, "shim")).toMatch(/^ok shim/);
  });

  it("curl: fails when not on PATH", async () => {
    const sb = await healthy();
    const r = await sb.run([], { onPath: (c) => c !== "curl" });
    expect(r.code).toBe(1);
    expect(line(r.stdout, "curl")).toMatch(/^fail curl[^\n]*\n {6}fix:.*curl/);
  });

  it("project: ok in the project and in a subfolder, fail elsewhere with `taskville init`", async () => {
    const sb = await healthy();
    const sub = join(sb.project, "src");
    mkdirSync(sub);
    expect(line((await sb.run([], {}, sub)).stdout, "project")).toMatch(/^ok project/);
    const other = join(sb.root, "other");
    mkdirSync(other);
    const r = await sb.run([], {}, other);
    expect(r.code).toBe(1);
    expect(line(r.stdout, "project")).toMatch(/^fail project[^\n]*\n {6}fix:.*taskville init/);
  });

  it("a single fail makes the exit code 1 while the other checks still report ok", async () => {
    const sb = await healthy();
    const r = await sb.run([], { onPath: () => false });
    expect(r.code).toBe(1);
    expect(r.stdout.split("\n").filter((l) => l.startsWith("ok ")).length).toBeGreaterThanOrEqual(
      6,
    );
  });
});

describe("taskville doctor output shape", () => {
  it("puts the fix on its own indented line under a failing check", async () => {
    const sb = await healthy();
    const r = await sb.run([], { engineHealthy: async () => false, onPath: () => false });
    const rows = r.stdout.split("\n");
    const engineAt = rows.findIndex((l) => l.startsWith("fail engine:"));
    expect(engineAt).toBeGreaterThanOrEqual(0);
    expect(rows[engineAt]).not.toContain("fix:");
    expect(rows[engineAt + 1]).toBe("      fix: taskville start");
    const curlAt = rows.findIndex((l) => l.startsWith("fail curl:"));
    expect(rows[curlAt]).not.toContain("fix:");
    expect(rows[curlAt + 1]).toMatch(/^ {6}fix: .*curl/);
    // Passing checks have no fix line.
    const okAt = rows.findIndex((l) => l.startsWith("ok node:"));
    expect(rows[okAt + 1]).toMatch(/^(ok|warn|fail) /);
  });
});

// The real engine probe: /health needs the CLI token, so the probe must send the home's token.
// Every probe except engineHealthy is injected; --url and --home name the engine explicitly.
describe("taskville doctor real engine probe", () => {
  const engineHome = tempDir("taskville-doctor-engine-");
  dirs.push(engineHome);
  const other = { nodeVersion: "26.8.2", webClientBuilt: () => true, onPath: () => true };

  const doctorOn = (home: string, url: string) =>
    cli(["doctor", "--home", home, "--url", url], {
      env: { HOME: home },
      cwd: home,
      isAlive: () => true,
      doctor: { ...other, listProjects: async () => [] },
    } as Parameters<typeof cli>[1]);

  it("reports a running engine as ok, naming the URL, using the home's token", async () => {
    const serve = await startServe(engineHome.path, await freePort(), () => new Date());
    try {
      const r = await doctorOn(engineHome.path, serve.url);
      expect(line(r.stdout, "engine")).toMatch(/^ok engine/);
      expect(line(r.stdout, "engine")).toContain(serve.url);
    } finally {
      await serve.stop();
    }
  });

  it("an engine that rejects the home's token is a fail about the token, not `no answer`", async () => {
    const serve = await startServe(engineHome.path, await freePort(), () => new Date());
    try {
      const wrong = tempDir("taskville-doctor-wrongtoken-");
      dirs.push(wrong);
      writeFileSync(join(wrong.path, "token"), "not-the-token\n", { mode: 0o600 });
      const r = await doctorOn(wrong.path, serve.url);
      const engine = line(r.stdout, "engine") ?? "";
      expect(r.code).toBe(1);
      expect(engine).toMatch(/^fail engine/);
      expect(engine).toMatch(/token/i);
      expect(engine).not.toMatch(/no answer/i);
      expect(engine).toMatch(/\n {6}fix: .*(taskville start|pair)/);
    } finally {
      await serve.stop();
    }
  });

  it("a server that answers 401 is also a token failure", async () => {
    const stub = createServer((_req, res) => {
      res.statusCode = 401;
      res.end("{}");
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    try {
      const port = (stub.address() as { port: number }).port;
      const home = tempDir("taskville-doctor-stub-");
      dirs.push(home);
      writeFileSync(join(home.path, "token"), "t\n", { mode: 0o600 });
      const r = await doctorOn(home.path, `http://127.0.0.1:${port}`);
      const engine = line(r.stdout, "engine") ?? "";
      expect(engine).toMatch(/^fail engine/);
      expect(engine).toMatch(/token/i);
      expect(engine).not.toMatch(/no answer/i);
    } finally {
      await new Promise((done) => stub.close(done));
    }
  });

  it("an unreachable URL still says no answer, with `taskville start`", async () => {
    const home = tempDir("taskville-doctor-dead-");
    dirs.push(home);
    writeFileSync(join(home.path, "token"), "t\n", { mode: 0o600 });
    const url = `http://127.0.0.1:${await freePort()}`;
    const r = await doctorOn(home.path, url);
    const engine = line(r.stdout, "engine") ?? "";
    expect(engine).toMatch(/^fail engine: no answer from /);
    expect(engine).toContain(url);
    expect(engine).toMatch(/\n {6}fix: taskville start/);
  });
});
