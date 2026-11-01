import { describe, expect, it } from "vitest";
import { BRIDGE_TOKEN, bearer, CLI_TOKEN, HOST, ORIGIN, sessionHeaders } from "../http/helpers.ts";
import { addProject, ingest, input, SseReader } from "../stream/helpers.ts";
import {
  type CrewResponse,
  evidenceIdsOf,
  type Harness,
  leadOf,
  PARALLEL,
  runBash,
  SPIKE_CWD,
  toolCallFrames,
  useHarness,
} from "./helpers.ts";

// M5.01 security rules for the feed, crew and evidence routes. They are read routes: the CLI token
// and a paired browser session may call them, the bridge token may not, Host and Origin are
// checked, and there is no CORS. The agent IDs and evidence IDs come from the URL, so they must
// never reach another project's data. Streams share the engine's stream cap and shutdown.
//
// Pinned: an agent is found by its events. With exactly one project holding the agent, `projectId`
// is optional. When more than one project has events for the same agent ID (one session whose
// cwd moved), the request must name one with `?projectId=` or gets 409 ambiguous_agent; a
// `projectId` that is unknown is 404 unknown_project, and one that does not hold the agent is
// 404 unknown_agent, the same answer as an agent that exists nowhere.

const start = useHarness();
const SESSION = "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918";

async function withRoutes(h: Harness) {
  h.addProject("spike", SPIKE_CWD);
  await h.play(PARALLEL.file);
  const ids = await evidenceIdsOf(h, PARALLEL.a, PARALLEL.aEdit);
  const enc = encodeURIComponent;
  return {
    feed: `/v1/agents/${enc(PARALLEL.a)}/feed`,
    crew: `/v1/agents/${enc(PARALLEL.lead)}/crew`,
    evidence: `/v1/evidence/${enc(ids.output)}`,
  };
}

describe("credentials, Host and Origin", () => {
  it("accepts the CLI token and a paired browser session, and sends no CORS headers", async () => {
    const h = await start();
    const paths = await withRoutes(h);
    const session = h.pairing.exchange(h.pairing.issueCode()) ?? "";
    for (const [name, path] of Object.entries(paths)) {
      const cli = await h.get(path, bearer(CLI_TOKEN));
      expect(cli.status, `${name} cli`).toBe(200);
      expect(cli.headers.get("access-control-allow-origin")).toBeNull();
      expect(cli.headers.get("cache-control")).toContain("no-store");
      await cli.body?.cancel();

      const browser = await h.get(path, { ...sessionHeaders(session), Origin: ORIGIN });
      expect(browser.status, `${name} session`).toBe(200);
      expect(browser.headers.get("access-control-allow-origin")).toBeNull();
      await browser.body?.cancel();
    }
    const feed = await h.get(paths.feed, bearer(CLI_TOKEN));
    expect(feed.headers.get("content-type")).toContain("text/event-stream");
    await feed.body?.cancel();
  });

  it("refuses the bridge token (403), a missing credential (401), a foreign Host and a foreign Origin (403)", async () => {
    const h = await start();
    const paths = await withRoutes(h);
    for (const [name, path] of Object.entries(paths)) {
      const bridge = await h.get(path, bearer(BRIDGE_TOKEN));
      expect(bridge.status, `${name} bridge`).toBe(403);
      expect(await bridge.json()).toEqual({
        error: { code: "credential_not_allowed", message: expect.any(String) },
      });
      expect((await h.get(path, { Host: HOST })).status, `${name} anonymous`).toBe(401);
      expect(
        (await h.get(path, { ...bearer(CLI_TOKEN), Host: "evil.example:4807" })).status,
        `${name} host`,
      ).toBe(403);
      expect(
        (await h.get(path, { ...bearer(CLI_TOKEN), Origin: "http://evil.example" })).status,
        `${name} origin`,
      ).toBe(403);
    }
  });

  it("ends a browser session's feed when its pairing is revoked, but not a CLI feed", async () => {
    const h = await start();
    await withRoutes(h);
    const session = h.pairing.exchange(h.pairing.issueCode()) ?? "";
    const path = `/v1/agents/${encodeURIComponent(PARALLEL.a)}/feed`;
    const head = h.engine.storage.head("spike") ?? 0;
    const browser = new SseReader(
      await h.get(`${path}?after=${head}`, { ...sessionHeaders(session), Origin: ORIGIN }),
    );
    const cli = new SseReader(await h.get(`${path}?after=${head}`, bearer(CLI_TOKEN)));

    const revoke = await h.app.request("http://127.0.0.1:4807/v1/pairing/revoke", {
      method: "POST",
      headers: bearer(CLI_TOKEN),
    });
    expect(await revoke.json()).toEqual({ revoked: 1 });

    await h.hook(
      {
        session_id: PARALLEL.session,
        cwd: SPIKE_CWD,
        agent_id: "afdf84bea07a9064c",
        agent_type: "general-purpose",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo after revoke" },
        tool_use_id: "toolu_after_revoke000000001",
      },
      "after-revoke",
    );
    expect(await browser.next()).toBeNull();
    const [frame] = await toolCallFrames(cli, 1);
    expect(frame?.data.toolCallId).toBe("toolu_after_revoke000000001");
    await cli.cancel();
  });
});

describe("stream limits", () => {
  it("counts feeds against the stream cap (503 too_many_streams) and frees a slot when one closes", async () => {
    const h = await start({ maxStreams: 2 });
    const { feed } = await withRoutes(h);
    const first = await h.get(feed);
    const second = await h.get(feed);
    const third = await h.get(feed);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(503);
    expect(await third.json()).toEqual({
      error: { code: "too_many_streams", message: expect.any(String) },
    });
    expect(h.engine.hub.openStreams()).toBe(2);

    await first.body?.cancel();
    for (let i = 0; i < 100 && h.engine.hub.openStreams() > 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const fourth = await h.get(feed);
    expect(fourth.status).toBe(200);
    await second.body?.cancel();
    await fourth.body?.cancel();
  });

  it("ends every open feed when the engine shuts down", async () => {
    const h = await start();
    const { feed } = await withRoutes(h);
    const live = new SseReader(await h.get(feed));
    await toolCallFrames(live, 6);
    h.engine.close();
    expect(h.engine.hub.openStreams()).toBe(0);
    expect(await live.next()).toBeNull();
  });

  it("cuts off a feed whose client stops reading, with resnapshot slow_consumer, and keeps the frames it sent gap-free", async () => {
    const h = await start({ queueLimit: 5 });
    addProject(h.engine.storage, "demo");
    const call = (i: number) =>
      input(`slow-${i}`, {
        type: "tool_call.started",
        agentId: "agent-1",
        payload: { toolCallId: `call-${i}`, toolName: "Bash" },
      });
    await ingest(h.app, [call(0)]);
    const slow = await h.feed("agent-1");
    expect(slow.status).toBe(200); // never read while the calls below arrive
    // One event per batch, so a write is already blocked on the unread client when the queue fills.
    for (let i = 1; i <= 20; i++) await ingest(h.app, [call(i)]);

    const reader = new SseReader(slow);
    const frames = [];
    for (;;) {
      const frame = await reader.next();
      if (frame === null) break;
      frames.push(frame);
    }
    expect(frames.at(-1)).toEqual({ event: "resnapshot", data: { reason: "slow_consumer" } });
    const delivered = frames.filter((f) => f.event === "toolcall").map((f) => f.id ?? 0);
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.length).toBeLessThan(21);
    expect(delivered).toEqual(delivered.map((_, i) => (delivered[0] ?? 0) + i));
    for (let i = 0; i < 100 && h.engine.hub.openStreams() > 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.engine.hub.openStreams()).toBe(0);
  });
});

describe("which project an agent belongs to", () => {
  const A_CALL = "toolu_alpha00000000000000001";
  const B_CALL = "toolu_bravo00000000000000001";

  /** One session whose cwd moved: the same lead agent ID has events in two projects. */
  async function twoProjects() {
    const h = await start();
    h.addProject("alpha", "/work/alpha");
    h.addProject("bravo", "/work/bravo");
    await runBash(h, {
      session: SESSION,
      toolUseId: A_CALL,
      command: "echo a",
      stdout: "a",
      cwd: "/work/alpha",
      label: "a",
    });
    await runBash(h, {
      session: SESSION,
      toolUseId: B_CALL,
      command: "echo b",
      stdout: "b",
      cwd: "/work/bravo",
      label: "b",
    });
    return h;
  }

  it("needs no projectId when exactly one project has the agent, and refuses a projectId that does not hold it", async () => {
    const h = await start();
    h.addProject("alpha", "/work/alpha");
    h.addProject("bravo", "/work/bravo");
    await runBash(h, {
      session: SESSION,
      toolUseId: A_CALL,
      command: "echo a",
      stdout: "a",
      cwd: "/work/alpha",
      label: "a",
    });
    const agent = leadOf(SESSION);

    for (const route of ["feed", "crew"] as const) {
      const call = (query: string) =>
        route === "feed" ? h.feed(agent, query) : h.crew(agent, query);
      const implied = await call("");
      expect(implied.status, route).toBe(200);
      await implied.body?.cancel();
      const named = await call("?projectId=alpha");
      expect(named.status, `${route} named`).toBe(200);
      await named.body?.cancel();

      const wrong = await call("?projectId=bravo");
      expect(wrong.status, `${route} wrong`).toBe(404);
      expect(await wrong.json()).toEqual({
        error: { code: "unknown_agent", message: expect.any(String) },
      });
      const nowhere = await call("?projectId=no-such-project");
      expect(nowhere.status, `${route} nowhere`).toBe(404);
      expect(await nowhere.json()).toEqual({
        error: { code: "unknown_project", message: expect.any(String) },
      });
      const crafted = await call(`?projectId=${encodeURIComponent("../alpha")}`);
      expect(crafted.status, `${route} crafted`).toBe(404);
      await crafted.body?.cancel();
    }
  });

  it("refuses to guess between projects (409 ambiguous_agent) and serves only the named project's calls", async () => {
    const h = await twoProjects();
    const agent = leadOf(SESSION);

    for (const route of ["feed", "crew"] as const) {
      const res = route === "feed" ? await h.feed(agent) : await h.crew(agent);
      expect(res.status, route).toBe(409);
      expect(await res.json()).toEqual({
        error: { code: "ambiguous_agent", message: expect.any(String) },
      });
    }

    const alpha = await h.openFeed(agent, "?projectId=alpha");
    const bravo = await h.openFeed(agent, "?projectId=bravo");
    const fromAlpha = await toolCallFrames(alpha, 2);
    const fromBravo = await toolCallFrames(bravo, 2);
    expect(fromAlpha.map((f) => f.data.toolCallId)).toEqual([A_CALL, A_CALL]);
    expect(fromBravo.map((f) => f.data.toolCallId)).toEqual([B_CALL, B_CALL]);
    await alpha.cancel();
    await bravo.cancel();

    const crew = (await (await h.crew(agent, "?projectId=bravo")).json()) as CrewResponse;
    expect(crew.projectId).toBe("bravo");
  });

  it("treats crafted agent IDs as plain unknown agents, never as paths or queries", async () => {
    const h = await start();
    await withRoutes(h);
    for (const agent of [
      "../../health",
      "../projects",
      `${PARALLEL.lead}/../${PARALLEL.a}`,
      `${PARALLEL.lead}%00`,
      "claude-code:*",
      "a".repeat(500),
    ]) {
      for (const route of ["feed", "crew"] as const) {
        const res = route === "feed" ? await h.feed(agent) : await h.crew(agent);
        expect(res.status, `${route} ${agent.slice(0, 24)}`).toBe(404);
        expect(await res.json()).toEqual({
          error: { code: "unknown_agent", message: expect.any(String) },
        });
      }
    }
  });
});
