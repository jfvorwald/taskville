import { eventBatchResponseSchema, MAX_BATCH_EVENTS } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { IngestPipeline, registerIngestRoute } from "../../src/ingest/index.ts";
import {
  BRIDGE_TOKEN,
  bearer,
  CLI_TOKEN,
  HOST,
  makeApp,
  ORIGIN,
  postJson,
  sessionHeaders,
} from "../http/helpers.ts";
import { fixedNow, input, useStorage } from "./helpers.ts";

const db = useStorage(["demo"]);
const URL = "http://127.0.0.1:4807/v1/events/batch";

function setup() {
  const { app, pairing } = makeApp();
  registerIngestRoute(app, new IngestPipeline({ storage: db.storage(), now: fixedNow }));
  return { app, pairing };
}

describe("POST /v1/events/batch", () => {
  it("ingests a batch with the CLI token and returns per-event results and heads", async () => {
    const { app } = setup();
    const res = await app.request(URL, postJson({ events: [input("e1"), input("e2")] }, bearer(CLI_TOKEN)));
    expect(res.status).toBe(200);
    const body = eventBatchResponseSchema.parse(await res.json());
    expect(body.results.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    expect(body.heads).toEqual({ demo: 3 });
  });

  it("answers 200 for a partial batch", async () => {
    const { app } = setup();
    const res = await app.request(
      URL,
      postJson({ events: [input("e1"), input("e2", { projectId: "ghost" })] }, bearer(CLI_TOKEN)),
    );
    expect(res.status).toBe(200);
    const body = eventBatchResponseSchema.parse(await res.json());
    expect(body.results.map((r) => r.status)).toEqual(["accepted", "rejected"]);
  });

  it("refuses a browser session and the bridge token with credential_not_allowed", async () => {
    const { app, pairing } = setup();
    const session = pairing.exchange(pairing.issueCode()) ?? "";
    for (const headers of [
      { ...sessionHeaders(session), Origin: ORIGIN },
      bearer(BRIDGE_TOKEN),
    ]) {
      const res = await app.request(URL, postJson({ events: [input("e1")] }, headers));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: expect.objectContaining({ code: "credential_not_allowed" }) });
    }
    expect(db.storage().head("demo")).toBe(1);
  });

  it("refuses a request without a credential or with a foreign Host", async () => {
    const { app } = setup();
    const anonymous = await app.request(URL, postJson({ events: [input("e1")] }, { Host: HOST }));
    expect(anonymous.status).toBe(401);
    const rebinding = await app.request(
      URL,
      postJson({ events: [input("e1")] }, { ...bearer(CLI_TOKEN), Host: "evil.test:4807" }),
    );
    expect(rebinding.status).toBe(403);
    expect(db.storage().head("demo")).toBe(1);
  });

  it("answers 400 bad_request when the body is not a batch", async () => {
    const { app } = setup();
    for (const body of ["{not json", JSON.stringify({ events: "nope" }), JSON.stringify([1]), JSON.stringify({ events: [], extra: 1 })]) {
      const res = await app.request(URL, {
        method: "POST",
        headers: { ...bearer(CLI_TOKEN), "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: expect.objectContaining({ code: "bad_request" }) });
    }
  });

  it("answers 413 for more than 5,000 events", async () => {
    const { app } = setup();
    const events = Array.from({ length: MAX_BATCH_EVENTS + 1 }, (_, i) => input(`e${i}`));
    const res = await app.request(URL, postJson({ events }, bearer(CLI_TOKEN)));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: expect.objectContaining({ code: "payload_too_large" }) });
    expect(db.storage().head("demo")).toBe(1);
  });

  it("answers 413 for a body over 5 MB", async () => {
    const { app } = setup();
    const big = { events: [input("e1", { type: "task.created", taskId: "t", payload: { title: "z".repeat(5 * 1024 * 1024) } })] };
    const res = await app.request(URL, postJson(big, bearer(CLI_TOKEN)));
    expect(res.status).toBe(413);
    expect(db.storage().head("demo")).toBe(1);
  });

  it("keeps the sequence gap-free and duplicate-free under concurrent requests", async () => {
    const { app } = setup();
    const requests = Array.from({ length: 20 }, (_, r) =>
      app.request(
        URL,
        postJson(
          // Every request also resends one event of the previous request: a race on the same key.
          { events: [...Array.from({ length: 10 }, (_, i) => input(`r${r}-${i}`)), input(`r${Math.max(0, r - 1)}-0`)] },
          bearer(CLI_TOKEN),
        ),
      ),
    );
    const bodies = await Promise.all(
      requests.map(async (p) => eventBatchResponseSchema.parse(await (await p).json())),
    );
    const accepted = bodies.flatMap((b) =>
      b.results.flatMap((r) => (r.status === "accepted" ? [r.ingestSequence] : [])),
    );
    expect(accepted.sort((a, b) => a - b)).toEqual(Array.from({ length: 200 }, (_, i) => i + 2));
    expect(bodies.flatMap((b) => b.results).filter((r) => r.status === "conflict")).toEqual([]);
    expect(db.storage().head("demo")).toBe(201);
    const sequences = [...db.storage().events("demo")].map((e) => e.ingestSequence);
    expect(sequences).toEqual(Array.from({ length: 201 }, (_, i) => i + 1));
  });
});
