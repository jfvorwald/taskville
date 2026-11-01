import { describe, expect, it, vi } from "vitest";
import {
  buildDecideBody,
  buildOpenBody,
  commandErrorMessage,
  fetchExactInput,
  sendCommand,
} from "../../../src/overlays/action-card/api.ts";

// M4.07: the card's two engine calls and their request bodies (contracts/http-api.md, commands
// section and the M4.04 exact-input route). The functions are pure apart from the injected `fetch`.

const SECRET = "session-secret-1";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("buildDecideBody", () => {
  const base = { projectId: "proj-1", requestId: "req-1", idempotencyKey: "key-1" };

  it("builds an allow command with exactly the contract's keys (bodies are strict)", () => {
    expect(buildDecideBody({ ...base, behavior: "allow" })).toStrictEqual({
      type: "permission.decide",
      projectId: "proj-1",
      requestId: "req-1",
      idempotencyKey: "key-1",
      decision: { behavior: "allow" },
    });
  });

  it("builds a deny with a note as `message`, trimmed", () => {
    expect(
      buildDecideBody({ ...base, behavior: "deny", note: "  use --dry-run first \n" }),
    ).toStrictEqual({
      type: "permission.decide",
      projectId: "proj-1",
      requestId: "req-1",
      idempotencyKey: "key-1",
      decision: { behavior: "deny", message: "use --dry-run first" },
    });
  });

  it.each([[""], ["   \n\t"]])("omits `message` for a blank note (%j)", (note) => {
    const body = buildDecideBody({ ...base, behavior: "deny", note });
    expect(body.decision).toStrictEqual({ behavior: "deny" });
  });

  it("omits `message` when there is no note", () => {
    expect(buildDecideBody({ ...base, behavior: "deny" }).decision).toStrictEqual({
      behavior: "deny",
    });
  });

  it("never sends a note with an allow", () => {
    const body = buildDecideBody({ ...base, behavior: "allow", note: "ignored" });
    expect(body.decision).toStrictEqual({ behavior: "allow" });
  });
});

describe("buildOpenBody", () => {
  it("builds a session.open command with the session from the request, and no cwd or opener", () => {
    expect(
      buildOpenBody({
        projectId: "proj-1",
        requestId: "req-1",
        sessionId: "sess-1",
        idempotencyKey: "k",
      }),
    ).toStrictEqual({
      type: "session.open",
      projectId: "proj-1",
      requestId: "req-1",
      sessionId: "sess-1",
      idempotencyKey: "k",
    });
  });
});

describe("fetchExactInput", () => {
  const args = { secret: SECRET, projectId: "proj 1", requestId: "req/1" };
  const held = {
    requestId: "req/1",
    projectId: "proj 1",
    sessionId: "sess-1",
    toolName: "Bash",
    toolInput: { command: "ls" },
    cwd: "/work/app",
  };

  it("GETs the request's input route with the project and the session header, both encoded", async () => {
    const fetch = vi.fn(async () => json(200, held));
    await fetchExactInput({ ...args, fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/v1/requests/req%2F1/input?projectId=proj%201");
    expect(init.method ?? "GET").toBe("GET");
    expect(new Headers(init.headers).get("X-Taskville-Session")).toBe(SECRET);
  });

  it("returns the held request on 200", async () => {
    const result = await fetchExactInput({ ...args, fetch: async () => json(200, held) });
    expect(result).toStrictEqual({ kind: "ok", input: held });
  });

  it("maps 410 to expired and 404 to unknown", async () => {
    const expired = { error: { code: "request_expired", message: "gone" } };
    const unknown = { error: { code: "unknown_request", message: "no" } };
    expect(await fetchExactInput({ ...args, fetch: async () => json(410, expired) })).toStrictEqual(
      {
        kind: "expired",
      },
    );
    expect(await fetchExactInput({ ...args, fetch: async () => json(404, unknown) })).toStrictEqual(
      {
        kind: "unknown",
      },
    );
  });

  it.each([
    ["a server error", () => json(500, { error: { code: "internal", message: "x" } })],
    ["an unauthorized session", () => json(401, { error: { code: "unauthorized", message: "x" } })],
    ["a body that is not the held-request shape", () => json(200, { hello: "world" })],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
  ])("reports failed for %s", async (_name, respond) => {
    expect(await fetchExactInput({ ...args, fetch: async () => respond() })).toStrictEqual({
      kind: "failed",
    });
  });

  it("reports failed when the network call throws", async () => {
    const fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await fetchExactInput({ ...args, fetch })).toStrictEqual({ kind: "failed" });
  });

  // M4.07 review fix (L1): the body must be for the request that was asked about.
  it("reports failed for a 200 whose requestId is not the one requested", async () => {
    const other = { ...held, requestId: "req/2" };
    expect(await fetchExactInput({ ...args, fetch: async () => json(200, other) })).toStrictEqual({
      kind: "failed",
    });
  });

  // M4.07 review fix (code review 8): the card aborts the request when it goes away.
  it("passes an AbortSignal to fetch when given one", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => json(200, held));
    await fetchExactInput({ ...args, fetch, signal: controller.signal });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
    expect(new Headers(init.headers).get("X-Taskville-Session")).toBe(SECRET);
  });

  it("reports failed when the request is aborted", async () => {
    const controller = new AbortController();
    const fetch = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const pending = fetchExactInput({
      ...args,
      fetch: fetch as unknown as typeof globalThis.fetch,
      signal: controller.signal,
    });
    controller.abort();
    const settled = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 300)),
    ]);
    expect(settled).toStrictEqual({ kind: "failed" });
  });
});

describe("sendCommand", () => {
  const body = buildDecideBody({
    projectId: "proj-1",
    requestId: "req-1",
    idempotencyKey: "key-1",
    behavior: "allow",
  });

  it("POSTs the JSON body to /v1/commands with the session header", async () => {
    const fetch = vi.fn(async () => json(200, { command: { id: "c1", status: "delivered" } }));
    await sendCommand({ fetch, secret: SECRET, body });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/v1/commands");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("X-Taskville-Session")).toBe(SECRET);
    expect(headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(JSON.parse(String(init.body))).toStrictEqual(body);
  });

  it("returns the command on success, including a session.open result", async () => {
    const command = {
      id: "c2",
      type: "session.open",
      requestId: "req-1",
      status: "succeeded",
      result: { outcome: "copy-only", sessionId: "sess-1", cwd: "/work/app" },
    };
    const result = await sendCommand({
      fetch: async () => json(200, { command }),
      secret: SECRET,
      body,
    });
    expect(result).toStrictEqual({ ok: true, command });
  });

  it("returns only the code and status of an error, never the server's message text", async () => {
    const error = { code: "request_expired", message: "SECRET-RAW-TEXT /Users/me/path" };
    const result = await sendCommand({
      fetch: async () => json(410, { error }),
      secret: SECRET,
      body,
    });
    expect(result).toStrictEqual({ ok: false, code: "request_expired", status: 410 });
  });

  it("reports code `unknown` for an error body it cannot read, and for a malformed success", async () => {
    expect(
      await sendCommand({
        fetch: async () => new Response("<html>", { status: 502 }),
        secret: SECRET,
        body,
      }),
    ).toStrictEqual({ ok: false, code: "unknown", status: 502 });
    expect(
      await sendCommand({ fetch: async () => json(200, { nope: true }), secret: SECRET, body }),
    ).toStrictEqual({ ok: false, code: "unknown", status: 200 });
  });

  it("reports code `network` with status 0 when the call throws", async () => {
    const fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await sendCommand({ fetch, secret: SECRET, body })).toStrictEqual({
      ok: false,
      code: "network",
      status: 0,
    });
  });
});

describe("commandErrorMessage", () => {
  const codes = [
    "request_not_open",
    "request_expired",
    "not_answerable",
    "command_in_flight",
    "opener_failed",
    "request_session_mismatch",
    "idempotency_conflict",
    "bad_request",
    "unknown_request",
    "unknown_session",
    "unknown_project",
    "history_context_rejected",
    "network",
    "unknown",
    "a_code_from_a_newer_engine",
  ];

  it.each(codes)("%s gets a short plain sentence, not the code", (code) => {
    const message = commandErrorMessage(code);
    expect(message.length).toBeGreaterThan(5);
    expect(message.length).toBeLessThanOrEqual(100);
    expect(message).not.toContain("_");
    expect(message).not.toContain(code);
  });

  it("says something specific for the codes a user can act on", () => {
    expect(commandErrorMessage("request_expired")).toMatch(/expired/i);
    expect(commandErrorMessage("request_not_open")).toMatch(/no longer open|already/i);
    expect(commandErrorMessage("not_answerable")).toMatch(/open the session|terminal/i);
    expect(commandErrorMessage("command_in_flight")).toMatch(/already running|in progress/i);
    expect(commandErrorMessage("opener_failed")).toMatch(/could not open/i);
    expect(commandErrorMessage("network")).toMatch(/try again/i);
  });
});
