import { CALM, runOffline } from "@taskville/demo";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli, freePort, startServe, tempDir } from "./helpers.ts";

const HASH = /6:[0-9a-f]{64}/;

describe("demo run --offline (US3-1, quickstart section 4)", () => {
  it("prints the same stateHash twice for the same seed", async () => {
    const first = await cli(["demo", "run", "--offline", "--seed", "42", "--duration", "30m"]);
    const second = await cli(["demo", "run", "--offline", "--seed", "42", "--duration", "30m"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(HASH);
    expect(second.stdout).toBe(first.stdout);
  });

  it("prints the hash runOffline computes", async () => {
    const result = await cli([
      "demo",
      "run",
      "--offline",
      "--seed",
      "42",
      "--duration",
      "30m",
      "--json",
    ]);
    const body = JSON.parse(result.stdout) as { stateHash: string; events: number; pace: string };
    const expected = runOffline({ seed: 42, pace: CALM, durationMs: 30 * 60_000 });
    expect(body).toMatchObject({
      stateHash: expected.stateHash,
      events: expected.events.length,
      pace: "calm",
    });
  });

  it("prints a different hash for another seed or pace", async () => {
    const hash = async (...extra: string[]) =>
      HASH.exec(
        (await cli(["demo", "run", "--offline", "--duration", "30m", ...extra])).stdout,
      )?.[0];
    const base = await hash("--seed", "42");
    expect(await hash("--seed", "43")).not.toBe(base);
    expect(await hash("--seed", "42", "--pace", "lively")).not.toBe(base);
    expect(await hash("--seed", "42", "--pace", "change=2s-6s,needs-you=90s")).toMatch(HASH);
  });

  it.each([
    [["demo", "run", "--seed", "42", "--duration", "1m"], /--offline/],
    [["demo", "run", "--offline", "--seed", "42"], /--duration/],
    [["demo", "run", "--offline", "--duration", "1m"], /--seed/],
    [["demo", "run", "--offline", "--seed", "x", "--duration", "1m"], /seed/],
    [["demo", "run", "--offline", "--seed", "1", "--duration", "10"], /duration/i],
    [["demo", "run", "--offline", "--seed", "1", "--duration", "1m", "--pace", "brisk"], /pace/i],
    [["demo", "run", "--offline", "--seed", "1", "--duration", `${"9".repeat(400)}h`], /duration/i],
    [["demo", "run", "--offline", "--seed", "1", "--duration", "0s"], /duration/i],
    [
      ["demo", "start", "--project", "demo", "--seed", "1", "--duration", `${"9".repeat(400)}s`],
      /duration/i,
    ],
    [
      [
        "demo",
        "run",
        "--offline",
        "--seed",
        "1",
        "--duration",
        "1m",
        "--pace",
        `change=1s-${"9".repeat(400)}s,needs-you=90s`,
      ],
      /pace/i,
    ],
    [
      [
        "demo",
        "run",
        "--offline",
        "--seed",
        "1",
        "--duration",
        "1m",
        "--pace",
        `change=1s-2s,needs-you=${"9".repeat(400)}m`,
      ],
      /pace/i,
    ],
    // A --home that does not exist, so a regression can never reach a real engine's token.
    [
      [
        "demo",
        "start",
        "--project",
        "demo",
        "--seed",
        "1",
        "--speed",
        `${"9".repeat(400)}.5`,
        "--home",
        "/nonexistent/taskville-home",
      ],
      /speed/,
    ],
    [["demo", "start", "--seed", "1"], /--project/],
    [["demo", "start", "--project", "demo", "--seed", "1", "--speed", "0"], /speed/],
    [["demo", "dance"], /demo/],
  ])("rejects %j with exit 1", async (argv, message) => {
    const result = await cli(argv);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(message);
  });
});

describe("demo start against a running engine", () => {
  const home = tempDir();
  let serve: Awaited<ReturnType<typeof startServe>>;
  let url = "";
  const at = (...args: string[]) =>
    cli([...args, "--home", home.path, "--url", url], { cwd: home.path });

  beforeAll(async () => {
    serve = await startServe(home.path, await freePort(), () => new Date());
    url = serve.url;
    expect((await at("project", "add", "--id", "demo", "--name", "Demo")).code).toBe(0);
  });
  afterAll(async () => {
    await serve.stop();
    home.remove();
  });

  it("posts an accelerated run that the engine accepts, as demo provenance, with six agents", async () => {
    const result = await at(
      "demo",
      "start",
      "--project",
      "demo",
      "--seed",
      "7",
      "--speed",
      "600",
      "--duration",
      "3m",
    );
    expect(result.code).toBe(0);
    const summary = /accepted (\d+) \/ duplicate (\d+)/.exec(result.stdout);
    expect(Number(summary?.[1])).toBeGreaterThan(10);
    expect(Number(summary?.[2])).toBe(0);

    const status = JSON.parse((await at("status", "--project", "demo", "--json")).stdout) as {
      cursor: number;
      agents: { kind: string; sourceId: string }[];
    };
    const topLevel = status.agents.filter((a) => a.kind === "session" || a.kind === "lead");
    expect(topLevel).toHaveLength(6);
    expect(new Set(status.agents.map((a) => a.sourceId))).toEqual(new Set(["demo:7"]));
    expect(status.cursor).toBe(1 + Number(summary?.[1]));

    // Every stored demo event carries demo provenance (US3-3).
    const controller = new AbortController();
    let out = "";
    const follow = cli(
      [
        "events",
        "follow",
        "--project",
        "demo",
        "--after",
        "1",
        "--json",
        "--home",
        home.path,
        "--url",
        url,
      ],
      {
        stdout: (s) => {
          out += s;
          if (out.split("\n").length > Number(summary?.[1])) controller.abort();
        },
        signal: controller.signal,
      },
    );
    expect((await follow).code).toBe(0);
    const envelopes = out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { provenance: string; sourceId: string });
    expect(envelopes).toHaveLength(Number(summary?.[1]));
    expect(new Set(envelopes.map((e) => e.provenance))).toEqual(new Set(["demo"]));
  });

  it("exits 2 for a project that was never added", async () => {
    const result = await at(
      "demo",
      "start",
      "--project",
      "ghost",
      "--seed",
      "1",
      "--speed",
      "600",
      "--duration",
      "1m",
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/ghost/);
  });

  it("stops cleanly on interrupt when no duration is given", async () => {
    const controller = new AbortController();
    let out = "";
    const run = cli(
      [
        "demo",
        "start",
        "--project",
        "demo",
        "--seed",
        "8",
        "--speed",
        "20",
        "--home",
        home.path,
        "--url",
        url,
      ],
      {
        stdout: (s) => {
          out += s;
          if (out.includes("Ctrl+C")) setTimeout(() => controller.abort(), 300);
        },
        signal: controller.signal,
      },
    );
    const result = await run;
    expect(result.code).toBe(0);
    expect(out).toMatch(/accepted [1-9]\d* \/ duplicate 0/);
  });
});
