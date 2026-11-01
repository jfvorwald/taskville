import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_HOLD_WINDOW_SECONDS,
  DEFAULT_PORT,
  DEFAULT_WORK_AREAS,
  loadConfig,
  MAX_HOLD_WINDOW_SECONDS,
  parseConfig,
  UNSORTED_PROJECT_ID,
} from "../../src/config/config.ts";

const ctx = { homedir: "/home/user", rootExists: () => true };

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  throw new Error("expected a ConfigError");
}

describe("defaults", () => {
  it("an empty config gives the documented defaults", () => {
    const { config, warnings } = parseConfig({}, ctx);
    expect(config).toEqual({
      port: 4807,
      projects: [],
      sessionOpener: null,
      workAreas: DEFAULT_WORK_AREAS,
      bridge: { holdWindowSeconds: 90, hookTimeoutSeconds: 95 },
    });
    expect(warnings).toEqual([]);
    expect(DEFAULT_PORT).toBe(4807);
    expect(DEFAULT_HOLD_WINDOW_SECONDS).toBe(90);
  });

  it("maps activities to work areas as ARCHITECTURE.md 8.3 does", () => {
    expect(DEFAULT_WORK_AREAS).toEqual({
      dispatching: "dispatch",
      implementing: "workshop",
      testing: "test_lab",
      reviewing: "review",
      researching: "archives",
      documenting: "archives",
    });
  });
});

describe("port", () => {
  it("takes the config value, and a CLI override beats it", () => {
    expect(parseConfig({ port: 5000 }, ctx).config.port).toBe(5000);
    expect(parseConfig({ port: 5000 }, { ...ctx, port: 6000 }).config.port).toBe(6000);
  });

  it("rejects ports that are not integers from 1024 to 65535", () => {
    for (const port of [0, 80, 70000, 1.5, "4807"]) {
      expect(issuesOf(() => parseConfig({ port }, ctx)).join("\n"), String(port)).toMatch(/^port:/);
    }
    expect(issuesOf(() => parseConfig({}, { ...ctx, port: 99999 })).join("\n")).toMatch(/--port/);
  });
});

describe("projects", () => {
  it("derives the ID from the name and normalizes roots", () => {
    const { config } = parseConfig(
      { projects: [{ name: "My Repo!", roots: ["/src/my-repo/", "~/work/../code/x"] }] },
      ctx,
    );
    expect(config.projects).toEqual([
      { id: "my-repo", name: "My Repo!", roots: ["/src/my-repo", "/home/user/code/x"] },
    ]);
  });

  it("keeps an explicit ID", () => {
    const { config } = parseConfig(
      { projects: [{ id: "tv", name: "Taskville", roots: ["/src/tv"] }] },
      ctx,
    );
    expect(config.projects[0]?.id).toBe("tv");
  });

  it("explains a relative root, naming where it is", () => {
    const issues = issuesOf(() =>
      parseConfig({ projects: [{ name: "a", roots: ["/ok", "src"] }] }, ctx),
    );
    expect(issues).toEqual([expect.stringMatching(/^projects\[0\]\.roots\[1\]: .*absolute/)]);
  });

  it("requires at least one root and a name", () => {
    const issues = issuesOf(() => parseConfig({ projects: [{ name: "", roots: [] }] }, ctx));
    expect(issues.join("\n")).toMatch(/projects\[0\]\.name/);
    expect(issues.join("\n")).toMatch(/projects\[0\]\.roots/);
  });

  it("reserves the built-in Unsorted ID", () => {
    expect(UNSORTED_PROJECT_ID).toBe("unsorted");
    const issues = issuesOf(() =>
      parseConfig({ projects: [{ name: "Unsorted", roots: ["/x"] }] }, ctx),
    );
    expect(issues.join("\n")).toMatch(/projects\[0\].*unsorted.*built-in/i);
  });

  it("rejects invalid and duplicate IDs", () => {
    expect(
      issuesOf(() =>
        parseConfig({ projects: [{ id: "Bad ID", name: "a", roots: ["/a"] }] }, ctx),
      ).join("\n"),
    ).toMatch(/projects\[0\]\.id/);
    expect(
      issuesOf(() => parseConfig({ projects: [{ name: "!!!", roots: ["/a"] }] }, ctx)).join("\n"),
    ).toMatch(/projects\[0\]/);
    const dup = issuesOf(() =>
      parseConfig(
        {
          projects: [
            { name: "Web", roots: ["/a"] },
            { id: "web", name: "Other", roots: ["/b"] },
          ],
        },
        ctx,
      ),
    );
    expect(dup.join("\n")).toMatch(/projects\[1\]\.id: .*"web".*projects\[0\]/);
  });

  it("rejects a root claimed twice", () => {
    const issues = issuesOf(() =>
      parseConfig(
        {
          projects: [
            { name: "a", roots: ["/src/x"] },
            { name: "b", roots: ["/src/x/"] },
          ],
        },
        ctx,
      ),
    );
    expect(issues.join("\n")).toMatch(/projects\[1\]\.roots\[0\]: .*\/src\/x.*projects\[0\]/);
  });

  it("warns, but does not fail, when a root does not exist", () => {
    const { warnings } = parseConfig(
      { projects: [{ name: "a", roots: ["/gone"] }] },
      { ...ctx, rootExists: () => false },
    );
    expect(warnings).toEqual([expect.stringMatching(/projects\[0\]\.roots\[0\].*\/gone/)]);
  });
});

describe("bridge hold window", () => {
  it("defaults to 90 s and sets the hook timeout 5 s above it", () => {
    expect(parseConfig({ bridge: { holdWindowSeconds: 120 } }, ctx).config.bridge).toEqual({
      holdWindowSeconds: 120,
      hookTimeoutSeconds: 125,
    });
  });

  // M4.04: the hold window is 1 to 300 whole seconds (it was 1 to 600 before the bridge shipped).
  it("accepts 1 and 300, the ends of the range, and caps the range at 300", () => {
    expect(MAX_HOLD_WINDOW_SECONDS).toBe(300);
    expect(parseConfig({ bridge: { holdWindowSeconds: 1 } }, ctx).config.bridge).toEqual({
      holdWindowSeconds: 1,
      hookTimeoutSeconds: 6,
    });
    expect(parseConfig({ bridge: { holdWindowSeconds: 300 } }, ctx).config.bridge).toEqual({
      holdWindowSeconds: 300,
      hookTimeoutSeconds: 305,
    });
  });

  it("rejects values outside 1 to 300 whole seconds, with a clear message", () => {
    for (const value of [0, -1, 301, 600, 601, 1.5, "90", null]) {
      expect(
        issuesOf(() => parseConfig({ bridge: { holdWindowSeconds: value } }, ctx)),
        String(value),
      ).toEqual(["bridge.holdWindowSeconds: must be a whole number of seconds from 1 to 300"]);
    }
  });
});

describe("work area overrides", () => {
  it("merges overrides onto the defaults", () => {
    const { config } = parseConfig({ workAreas: { testing: "review", waiting: "dispatch" } }, ctx);
    expect(config.workAreas).toEqual({
      ...DEFAULT_WORK_AREAS,
      testing: "review",
      waiting: "dispatch",
    });
  });

  it("names valid activities and areas when one is wrong", () => {
    const issues = issuesOf(() =>
      parseConfig({ workAreas: { coding: "workshop", testing: "lab" } }, ctx),
    );
    expect(issues.join("\n")).toMatch(/workAreas.*coding.*implementing/);
    expect(issues.join("\n")).toMatch(/workAreas\.testing:.*test_lab/);
  });
});

describe("unknown and malformed input", () => {
  it("rejects unknown keys, listing the allowed ones", () => {
    const issues = issuesOf(() => parseConfig({ prot: 1 }, ctx));
    expect(issues.join("\n")).toMatch(/prot.*port, projects, sessionOpener, workAreas, bridge/);
  });

  it("rejects a non-object config", () => {
    expect(issuesOf(() => parseConfig([], ctx)).join("\n")).toMatch(/object/);
  });

  it("reports every problem at once", () => {
    const issues = issuesOf(() =>
      parseConfig({ port: 1, bridge: { holdWindowSeconds: 0 }, sessionOpener: "open {cwd}" }, ctx),
    );
    expect(issues).toHaveLength(3);
  });
});

describe("loadConfig", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "taskville-config-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("uses defaults when there is no config file", () => {
    expect(loadConfig({ home }).config.port).toBe(4807);
  });

  it("reads config.json and checks roots on disk", () => {
    const root = join(home, "repo");
    mkdirSync(root);
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        port: 5001,
        projects: [
          { name: "Repo", roots: [root] },
          { name: "Gone", roots: [join(home, "gone")] },
        ],
      }),
    );
    const { config, warnings } = loadConfig({ home });
    expect(config.port).toBe(5001);
    expect(config.projects.map((p) => p.id)).toEqual(["repo", "gone"]);
    expect(warnings).toHaveLength(1);
  });

  it("names the file and the position of a JSON syntax error", () => {
    writeFileSync(join(home, "config.json"), '{ "port": 4807, }');
    const err = (() => {
      try {
        loadConfig({ home });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain(join(home, "config.json"));
    expect((err as ConfigError).message).toMatch(/JSON/);
  });

  it("refuses a config file that group or others can write", () => {
    const path = join(home, "config.json");
    writeFileSync(path, "{}");
    chmodSync(path, 0o664);
    expect(() => loadConfig({ home })).toThrow(/config\.json.*chmod/);
  });

  it("refuses a hold window over 300 s at load, naming the file, the setting, and the range", () => {
    const path = join(home, "config.json");
    writeFileSync(path, JSON.stringify({ bridge: { holdWindowSeconds: 301 } }), { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(() => loadConfig({ home })).toThrow(
      `${path}: bridge.holdWindowSeconds: must be a whole number of seconds from 1 to 300`,
    );
  });

  it("prefixes issues with the file path in the error message", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 1 }));
    expect(() => loadConfig({ home })).toThrow(/config\.json: port:/);
  });
});
