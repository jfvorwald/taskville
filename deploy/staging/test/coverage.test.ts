// Coverage gaps: the agent feed, evidence body shape, and SSE cleanup.

import { sseFrameSchema } from "@taskville/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sseResponse } from "../src/sse.ts";
import { makeStaging, pair, readSse, withSession } from "./support.ts";

async function setup() {
  const staging = makeStaging();
  const session = await pair(staging);
  const head = (
    (await (await staging.call("/v1/projects", withSession(session))).json()) as {
      projects: { id: string; head: number }[];
    }
  ).projects.find((p) => p.id === "demo")?.head as number;
  return { staging, session, head };
}

describe("agent feed", () => {
  it("opens with a heartbeat carrying the head", async () => {
    const { staging, session, head } = await setup();
    const response = await staging.call("/v1/agents/a1/feed?after=0", withSession(session));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const [frame] = await readSse(response, (all) => all.length >= 1);
    expect(frame?.raw).toMatch(/^event: heartbeat\ndata: \{.*\}\n\n$/);
    expect(
      sseFrameSchema.parse({ event: frame?.event, data: JSON.parse(frame?.data ?? "") }),
    ).toEqual({
      event: "heartbeat",
      data: { head },
    });
  });

  it("answers a cursor ahead of the head with a resnapshot", async () => {
    const { staging, session, head } = await setup();
    const response = await staging.call(
      `/v1/agents/a1/feed?after=${head + 1}`,
      withSession(session),
    );
    const [frame] = await readSse(response, (all) => all.length >= 1);
    expect(frame?.event).toBe("resnapshot");
    expect(JSON.parse(frame?.data ?? "")).toEqual({ reason: "cursor_ahead_of_head" });
  });

  it("refuses a bad cursor with 400", async () => {
    const { staging, session } = await setup();
    for (const after of ["-1", "abc", "1.5", "01"]) {
      const response = await staging.call(
        `/v1/agents/a1/feed?after=${after}`,
        withSession(session),
      );
      expect(response.status, after).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "bad_request",
      );
    }
  });
});

describe("evidence", () => {
  it("answers with the engine's body shape and echoes the id", async () => {
    const { staging, session } = await setup();
    const response = await staging.call("/v1/evidence/some-id", withSession(session));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["bytes", "id", "masks", "part", "projectId", "text", "toolCallId", "truncated"].sort(),
    );
    expect(body.id).toBe("some-id");
    expect(typeof body.projectId).toBe("string");
    expect(typeof body.toolCallId).toBe("string");
    expect(["input", "output"]).toContain(body.part);
    expect(typeof body.text).toBe("string");
    expect(Array.isArray(body.masks)).toBe(true);
    expect(typeof body.truncated).toBe("boolean");
    expect(typeof body.bytes).toBe("number");
  });
});

describe("SSE cleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a heartbeat every 15 seconds while open", async () => {
    vi.useFakeTimers();
    const response = sseResponse([], { heartbeat: () => ({ event: "heartbeat", data: "{}" }) });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(15_000);
    const first = await pending;
    expect(new TextDecoder().decode(first.value)).toBe("event: heartbeat\ndata: {}\n\n");
    await reader.cancel();
  });

  it("cancel() clears the heartbeat interval", async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(() => ({ event: "heartbeat", data: "{}" }));
    const response = sseResponse([{ event: "event", data: "{}", id: "1" }], { heartbeat });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    expect(vi.getTimerCount()).toBe(1);
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it("a stream with no heartbeat ends by itself and leaves no timer", async () => {
    vi.useFakeTimers();
    const response = sseResponse([{ event: "resnapshot", data: "{}" }]);
    const text = await response.text();
    expect(text).toBe("event: resnapshot\ndata: {}\n\n");
    expect(vi.getTimerCount()).toBe(0);
  });
});
