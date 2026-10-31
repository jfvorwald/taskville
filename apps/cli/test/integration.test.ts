import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli, FIXTURES, freePort, GOLDEN, startServe, tempDir } from "./helpers.ts";

// End to end in one process: `taskville serve --headless` on a free loopback port with a fixed
// engine clock, then the commands against it, as in quickstart.md section 2. Goldens are
// reviewed by hand; to accept an intended change run with CLI_UPDATE_GOLDEN=1 and review the diff.

const golden = (name: string, actual: string) => {
  const path = join(GOLDEN, name);
  if (process.env.CLI_UPDATE_GOLDEN === "1") writeFileSync(path, actual);
  return readFileSync(path, "utf8");
};
/** stateHash covers engine-assigned event IDs (test evidence), so it is checked, then masked. */
const stable = (json: string) => {
  const parsed = JSON.parse(json) as { stateHash: string };
  expect(parsed.stateHash).toMatch(/^1:[0-9a-f]{64}$/);
  return `${JSON.stringify({ ...parsed, stateHash: "<stateHash>" }, null, 2)}\n`;
};
const expected = (fixture: string) =>
  JSON.parse(readFileSync(join(FIXTURES, fixture.replace(".jsonl", ".expected.json")), "utf8")) as {
    results: { line: number; status: string; code?: string }[];
  };

describe("serve, projects, ingest, status, requests, follow, unpair", () => {
  const home = tempDir();
  let serve: Awaited<ReturnType<typeof startServe>>;
  let url = "";
  const at = (...args: string[]) =>
    cli([...args, "--home", home.path, "--url", url], { cwd: home.path });

  beforeAll(async () => {
    const port = await freePort();
    serve = await startServe(home.path, port, () => new Date("2026-10-30T09:05:00Z"));
    url = serve.url;
  });
  afterAll(async () => {
    expect(await serve.stop()).toBe(0);
    home.remove();
  });

  it("prints the one-time pairing URL, whose code pairs a browser exactly once", async () => {
    const match = /(http:\/\/127\.0\.0\.1:\d+)\/#pair=([A-Za-z0-9_-]+)/.exec(serve.output());
    expect(match?.[1]).toBe(url);
    const pair = () =>
      fetch(`${url}/v1/pairing`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: url },
        body: JSON.stringify({ code: match?.[2] }),
      });
    expect((await pair()).status).toBe(200);
    expect((await pair()).status).toBe(401);
    expect(serve.errors()).not.toContain(match?.[2]);
  });

  it("reports storage health and version on /health", async () => {
    const token = readFileSync(join(home.path, "token"), "utf8").trim();
    const res = await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await res.json()).toMatchObject({
      status: "ok",
      db: "ok",
      walMode: true,
      version: expect.any(String),
    });
  });

  it("adds a project once, then exits 2 for the same ID", async () => {
    const added = await at("project", "add", "--id", "demo", "--name", "Demo", "--root", ".");
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("demo");
    const again = await at("project", "add", "--id", "demo", "--name", "Demo");
    expect(again.code).toBe(2);
    expect(again.stderr).toMatch(/exists/);
  });

  it("lists projects, Unsorted always included, roots resolved to absolute paths", async () => {
    const list = await at("project", "list");
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/^demo\tDemo\t\/.+\t1$/m);
    expect(list.stdout).toMatch(/^unsorted\tUnsorted\t-\t1$/m);
    const json = JSON.parse((await at("project", "list", "--json")).stdout) as {
      projects: { id: string }[];
    };
    expect(json.projects.map((p) => p.id)).toEqual(["demo", "unsorted"]);
  });

  it("ingests the basic fixture, then the same file again as duplicates (quickstart)", async () => {
    const file = join(FIXTURES, "basic-two-agents.jsonl");
    const first = await at("events", "ingest", "--file", file);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("accepted 12 / duplicate 0 / conflict 0 / rejected 0");
    const second = await at("events", "ingest", "--file", file);
    expect(second.stdout).toContain("accepted 0 / duplicate 12 / conflict 0 / rejected 0");
  });

  it("shows the quickstart status header and the golden status --json", async () => {
    const status = await at("status", "--project", "demo");
    expect(status.code).toBe(0);
    expect(status.stdout.split("\n")[0]).toBe(
      "Demo · 1 active · 0 needs you · 0 trouble · 0 waiting",
    );
    const json = await at("status", "--project", "demo", "--json");
    expect(json.code).toBe(0);
    expect(stable(json.stdout)).toBe(golden("basic-status.json", stable(json.stdout)));
  });

  it("exits 4 and lists conflicts by line", async () => {
    const result = await at("events", "ingest", "--file", join(FIXTURES, "conflicts.jsonl"));
    expect(result.code).toBe(4);
    for (const r of expected("conflicts.jsonl").results.filter((x) => x.status === "conflict")) {
      expect(result.stdout).toContain(`line ${r.line}: conflict`);
    }
  });

  it("exits 4 with line-numbered rejections, unknown_project included, creating nothing", async () => {
    const result = await at("events", "ingest", "--file", join(FIXTURES, "invalid.jsonl"));
    expect(result.code).toBe(4);
    expect(result.stdout).toContain("accepted 0 / duplicate 0 / conflict 0 / rejected 11");
    for (const r of expected("invalid.jsonl").results) {
      expect(result.stdout).toContain(`line ${r.line}: ${r.code}`);
    }
    const list = await at("project", "list", "--json");
    expect((JSON.parse(list.stdout) as { projects: unknown[] }).projects).toHaveLength(2);
  });

  it("lists requests read-only, with the hint, and never offers to answer", async () => {
    const result = await at("requests", "--project", "demo");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No open requests.");
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(
      "Answer from the paired browser or in the agent's terminal.",
    );
  });

  it("exits 2 for an unknown project", async () => {
    for (const args of [
      ["status", "--project", "ghost"],
      ["requests", "--project", "ghost"],
    ]) {
      const result = await at(...args);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/ghost/);
    }
  });

  it("follows the backlog in order and stops cleanly on interrupt", async () => {
    const controller = new AbortController();
    let out = "";
    const done = cli(
      ["events", "follow", "--project", "demo", "--after", "0", "--home", home.path, "--url", url],
      {
        stdout: (s) => {
          out += s;
          if (/^13 /m.test(out)) controller.abort();
        },
        signal: controller.signal,
      },
    );
    expect((await done).code).toBe(0);
    const sequences = out
      .split("\n")
      .filter((l) => /^\d+ /.test(l))
      .map((l) => Number(l.split(" ")[0]));
    expect(sequences).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(out).toContain("Following demo after cursor 0");
  });

  it("takes a new snapshot when the cursor is ahead, and says where it resumes", async () => {
    const controller = new AbortController();
    let out = "";
    const done = cli(
      [
        "events",
        "follow",
        "--project",
        "demo",
        "--after",
        "999",
        "--home",
        home.path,
        "--url",
        url,
      ],
      {
        stdout: (s) => {
          out += s;
          if (out.includes("resuming from cursor")) controller.abort();
        },
        signal: controller.signal,
      },
    );
    expect((await done).code).toBe(0);
    expect(out).toContain("resnapshot (cursor_ahead_of_head): resuming from cursor 13");
  });

  it("rejects an event too large for one request by line, and still ingests the rest", async () => {
    const event = (n: number, extra = "") =>
      JSON.stringify({
        schemaVersion: 1,
        projectId: "demo",
        sourceId: "adapter:big",
        sourceEventId: `big-${n}`,
        occurredAt: "2026-10-30T09:01:00Z",
        type: "agent.connected",
        agentId: `big-agent-${n}`,
        payload: {},
        provenance: "live",
        ...(extra === "" ? {} : { correlationId: "c", evidenceIds: [], late: false, x: extra }),
      });
    const file = join(home.path, "big.jsonl");
    writeFileSync(file, [event(1), event(2, "y".repeat(6 * 1024 * 1024)), event(3)].join("\n"));
    const result = await at("events", "ingest", "--file", file);
    expect(result.code).toBe(4);
    expect(result.stdout).toContain("accepted 2 / duplicate 0 / conflict 0 / rejected 1");
    expect(result.stdout).toMatch(/^line 2: event_too_large/m);
  });

  it("revokes browser pairings", async () => {
    const result = await at("unpair");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Revoked 1 browser session");
  });

  it("exits 5 with the wrong token and 3 when the engine is unreachable", async () => {
    const other = tempDir();
    writeFileSync(join(other.path, "token"), "w".repeat(43), { mode: 0o600 });
    chmodSync(join(other.path, "token"), 0o600);
    const denied = await cli(["project", "list", "--home", other.path, "--url", url]);
    expect(denied.code).toBe(5);
    const port = await freePort();
    const unreachable = await cli([
      "project",
      "list",
      "--home",
      other.path,
      "--url",
      `http://127.0.0.1:${port}`,
    ]);
    expect(unreachable.code).toBe(3);
    expect(unreachable.stderr).toMatch(/unreachable/i);
    other.remove();
  });
});

describe("status tree for a crew (subagents and a team)", () => {
  const home = tempDir();
  let serve: Awaited<ReturnType<typeof startServe>>;
  let url = "";
  const at = (...args: string[]) =>
    cli([...args, "--home", home.path, "--url", url], { cwd: home.path });

  beforeAll(async () => {
    serve = await startServe(home.path, await freePort(), () => new Date("2026-10-30T10:05:00Z"));
    url = serve.url;
    expect((await at("project", "add", "--id", "demo", "--name", "Demo")).code).toBe(0);
    expect((await at("events", "ingest", "--file", join(FIXTURES, "crew.jsonl"))).code).toBe(0);
  });
  afterAll(async () => {
    await serve.stop();
    home.remove();
  });

  it("matches the golden tree without --all (finished subagents hidden)", async () => {
    const result = await at("status", "--project", "demo");
    expect(result.stdout).toBe(golden("crew-tree.txt", result.stdout));
    expect(result.stdout).not.toContain("explorer");
  });

  it("matches the golden tree with --all", async () => {
    const result = await at("status", "--project", "demo", "--all");
    expect(result.stdout).toBe(golden("crew-tree-all.txt", result.stdout));
    expect(result.stdout).toContain("explorer");
  });

  it("matches the golden status --json", async () => {
    const result = await at("status", "--project", "demo", "--json", "--all");
    expect(stable(result.stdout)).toBe(golden("crew-status.json", stable(result.stdout)));
  });

  it("lists the closed request only with --all, marked not answerable", async () => {
    expect((await at("requests")).stdout).toContain("No open requests.");
    const all = await at("requests", "--all");
    expect(all.stdout).toMatch(
      /demo\s.*permission\s.*Bash\s.*answerable: no\s.*answered_elsewhere/,
    );
  });
});

describe("projects from the config file", () => {
  it("registers them at start and never edits the file", async () => {
    const home = tempDir();
    const config = join(home.path, "config.json");
    const text = JSON.stringify({
      projects: [{ id: "cfg", name: "Configured", roots: ["/repo/cfg"] }],
    });
    writeFileSync(config, text, { mode: 0o600 });
    const serve = await startServe(
      home.path,
      await freePort(),
      () => new Date("2026-10-30T09:00:00Z"),
    );
    const list = await cli(["project", "list", "--home", home.path, "--url", serve.url]);
    expect(list.stdout).toMatch(/^cfg\tConfigured\t\/repo\/cfg\t1$/m);
    expect(await serve.stop()).toBe(0);
    expect(readFileSync(config, "utf8")).toBe(text);
    home.remove();
  });
});
