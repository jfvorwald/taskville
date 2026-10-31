import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openEvidenceStore } from "@taskville/engine/src/evidence/index.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, startServe, tempDir } from "./helpers.ts";

// M2.06 composition: `taskville serve` mounts POST /v1/sources/claude-code/hooks with the real
// mapper (M2.03) and the evidence store. Posts the S-2 nested-subagent recording end to end.
const STREAM = join(import.meta.dirname, "../../../fixtures/claude-code/subagent/nested.jsonl");
const BASH_CALL = "toolu_015WFqWypLHXWoXKeUEQmnfh";
const SECRET_CALL = "toolu_seeded0000000000000000";

describe("serve with the Claude Code hooks route", () => {
  const home = tempDir();
  let serve: Awaited<ReturnType<typeof startServe>>;
  let token = "";
  const post = (path: string, body: unknown) =>
    fetch(`${serve.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    serve = await startServe(home.path, await freePort(), () => new Date("2026-10-31T12:00:00Z"));
    token = readFileSync(join(home.path, "token"), "utf8").trim();
  });
  afterAll(async () => {
    if (serve) expect(await serve.stop()).toBe(0);
    home.remove();
  });

  it("maps every hook into the project whose root is the cwd and stores tool bodies redacted", async () => {
    const created = await post("/v1/projects", {
      id: "spike",
      name: "Spike",
      roots: ["/tmp/spike-s2/proj"],
    });
    expect(created.status).toBe(201);

    const hooks = readFileSync(STREAM, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => (JSON.parse(line) as { input: Record<string, unknown> }).input);
    let accepted = 0;
    for (const [i, payload] of hooks.entries()) {
      const res = await post("/v1/sources/claude-code/hooks", {
        sourceEventId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        payload,
      });
      expect(res.status, `hook ${i}`).toBe(200);
      const body = (await res.json()) as { projectId: string; results: { status: string }[] };
      expect(body.projectId).toBe("spike");
      for (const r of body.results) expect(r.status).toBe("accepted");
      accepted += body.results.length;
    }
    expect(accepted).toBeGreaterThan(hooks.length / 2);

    // One more Bash call, copied from the recording, whose output carries a seeded token.
    const secret = `${["gh", "p_"].join("")}Zq7Xw2Lr9Kd4Mn8Pv3Ts6Hb1Jc5Gf0Ye2Ua7Rk`;
    const pre = hooks.find(
      (h) => h.tool_use_id === BASH_CALL && h.hook_event_name === "PreToolUse",
    );
    const postHook = hooks.find(
      (h) => h.tool_use_id === BASH_CALL && h.hook_event_name === "PostToolUse",
    );
    for (const [i, hook] of [pre, postHook].entries()) {
      const res = await post("/v1/sources/claude-code/hooks", {
        sourceEventId: `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`,
        payload: {
          ...hook,
          tool_use_id: SECRET_CALL,
          ...(i === 1 ? { tool_response: { stdout: `token ${secret}`, stderr: "" } } : {}),
        },
      });
      expect(res.status).toBe(200);
      const { results } = (await res.json()) as { results: { status: string }[] };
      for (const r of results) expect(r.status).toBe("accepted");
      accepted += results.length;
    }

    const projects = (await (
      await fetch(`${serve.url}/v1/projects`, { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { projects: { id: string; head: number }[] };
    expect(projects.projects.find((p) => p.id === "spike")?.head).toBe(accepted + 1);
    expect(projects.projects.find((p) => p.id === "unsorted")?.head).toBe(1);

    expect(await serve.stop()).toBe(0);
    const evidencePath = join(home.path, "evidence.db");
    expect(existsSync(evidencePath)).toBe(true);
    const store = openEvidenceStore(evidencePath);
    try {
      expect(store.get("spike", BASH_CALL)).toMatchObject({
        input: { status: "stored", text: expect.stringContaining("echo nested-ok") },
        output: { status: "stored", text: expect.stringContaining('"stdout":"nested-ok"') },
      });
      const seeded = store.get("spike", SECRET_CALL)?.output;
      expect(seeded).toMatchObject({ status: "stored", masked: true });
    } finally {
      store.close();
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${evidencePath}${suffix}`;
      if (existsSync(file))
        expect(readFileSync(file).toString("latin1")).not.toContain("Zq7Xw2Lr9Kd4");
    }
  });
});
