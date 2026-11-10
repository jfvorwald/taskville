import { describe, expect, it } from "vitest";
import { HOST, ORIGIN, postJson, sessionHeaders } from "../../http/helpers.ts";
import {
  BRIDGE_TOKEN,
  bearer,
  CLI_TOKEN,
  costOf,
  fixture,
  LOGS_URL,
  METRICS_URL,
  makeOtlpApp,
  PARALLEL,
  sendLogs,
  sendMetrics,
} from "./helpers.ts";

// M5.12 (#104): "same credential and Host rules as every other route". The receiver is a source
// route like the Claude Code hooks route (M2.02): scope `ingest` (the CLI token only; the bridge
// token and a browser session get 403 credential_not_allowed), loopback Host only, a foreign
// Origin refused, 5 MB body limit (413 payload_too_large), 400 bad_request that never echoes the
// body, and 415 unsupported_media_type for anything but JSON (the installer sets
// OTEL_EXPORTER_OTLP_PROTOCOL=http/json; protobuf is not supported). Reading cost needs scope
// `read`: the CLI token and a paired browser session, never the bridge token.

const ENDPOINTS = [
  ["metrics", METRICS_URL, "metrics-parallel.json"],
  ["logs", LOGS_URL, "logs-api-requests.json"],
] as const;

type Reply = { error: { code: string; message?: string } };
const errorCode = async (res: Response) => ((await res.json()) as Reply).error.code;

describe.each(ENDPOINTS)("POST %s: credentials and Host", (_name, url, file) => {
  it("answers 401 for no credential and for a wrong token, and stores nothing", async () => {
    const { app } = await makeOtlpApp();
    const body = fixture(file);
    const anonymous = await app.request(url, postJson(body, { Host: HOST, Origin: ORIGIN }));
    expect(anonymous.status).toBe(401);
    const wrong = await app.request(
      url,
      postJson(body, bearer("not-the-cli-token-0123456789abcdefghijklmnop")),
    );
    expect(wrong.status).toBe(401);
    expect((await costOf(app, PARALLEL.lead)).status).toBe(404);
  });

  it("refuses a foreign Host and a foreign Origin", async () => {
    const { app } = await makeOtlpApp();
    const body = fixture(file);
    const host = await app.request(
      url,
      postJson(body, { ...bearer(CLI_TOKEN), Host: "evil.example:4807" }),
    );
    expect(await errorCode(host)).toBe("forbidden_host");
    const origin = await app.request(
      url,
      postJson(body, { ...bearer(CLI_TOKEN), Origin: "http://evil.example" }),
    );
    expect(await errorCode(origin)).toBe("forbidden_origin");
    expect((await costOf(app, PARALLEL.lead)).status).toBe(404);
    // The control: the same body with the right Host and token is accepted.
    expect((await app.request(url, postJson(body, bearer(CLI_TOKEN)))).status).toBe(200);
  });

  it("refuses the bridge token and a browser session with 403 credential_not_allowed", async () => {
    const { app, pairing } = await makeOtlpApp();
    const session = pairing.exchange(pairing.issueCode()) ?? "";
    for (const headers of [bearer(BRIDGE_TOKEN), { ...sessionHeaders(session), Origin: ORIGIN }]) {
      const res = await app.request(url, postJson(fixture(file), headers));
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("credential_not_allowed");
    }
    expect((await costOf(app, PARALLEL.lead)).status).toBe(404);
  });

  it("rejects a body over 5 MB with 413 payload_too_large", async () => {
    const { app } = await makeOtlpApp();
    const padding = "x".repeat(5 * 1024 * 1024 + 1);
    const res = await app.request(url, postJson({ pad: padding }, bearer(CLI_TOKEN)));
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe("payload_too_large");
  });

  it("answers 400 bad_request for malformed JSON without echoing any of it", async () => {
    const { app } = await makeOtlpApp();
    const secret = "sk-ant-api03-ZZZZ-should-never-come-back";
    for (const raw of [`{"resourceMetrics": [ "${secret}"`, `not json ${secret}`, ""]) {
      const res = await app.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(CLI_TOKEN) },
        body: raw,
      });
      expect(res.status, raw).toBe(400);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe("bad_request");
      expect(text).not.toContain(secret);
      expect(text).not.toContain("resourceMetrics");
    }
  });

  it("answers 400 bad_request for JSON that is not an OTLP export, without echoing it", async () => {
    const { app } = await makeOtlpApp();
    const secret = "sk-ant-api03-QQQQ-should-never-come-back";
    for (const body of [
      [],
      "text",
      7,
      null,
      { resourceMetrics: secret },
      { resourceLogs: { a: secret } },
    ]) {
      const res = await app.request(url, postJson(body, bearer(CLI_TOKEN)));
      expect(res.status, JSON.stringify(body)).toBe(400);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe("bad_request");
      expect(text).not.toContain(secret);
    }
  });

  it("answers 415 unsupported_media_type for protobuf", async () => {
    const { app } = await makeOtlpApp();
    const res = await app.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-protobuf", ...bearer(CLI_TOKEN) },
      body: new Uint8Array([10, 0]),
    });
    expect(res.status).toBe(415);
    expect(await errorCode(res)).toBe("unsupported_media_type");
  });

  it("accepts the CLI token (the control for the refusals above)", async () => {
    const { app } = await makeOtlpApp();
    const res = await app.request(url, postJson(fixture(file), bearer(CLI_TOKEN)));
    expect(res.status).toBe(200);
  });
});

describe("GET /v1/agents/:id/cost: credentials", () => {
  it("serves the CLI token and a paired browser session, and refuses the bridge token and no credential", async () => {
    const { app, pairing } = await makeOtlpApp();
    expect((await sendMetrics(app, fixture("metrics-parallel.json"))).status).toBe(200);
    const session = pairing.exchange(pairing.issueCode()) ?? "";
    expect((await costOf(app, PARALLEL.a, bearer(CLI_TOKEN))).status).toBe(200);
    expect((await costOf(app, PARALLEL.a, sessionHeaders(session))).status).toBe(200);
    expect((await costOf(app, PARALLEL.a, bearer(BRIDGE_TOKEN))).status).toBe(403);
    expect((await costOf(app, PARALLEL.a, { Host: HOST })).status).toBe(401);
    expect(
      (await costOf(app, PARALLEL.a, { ...bearer(CLI_TOKEN), Host: "evil.example:4807" })).status,
    ).toBe(403);
  });

  it("is the same through sendLogs: a rejected export changes nothing", async () => {
    const { app } = await makeOtlpApp();
    const rejected = await sendLogs(app, fixture("logs-api-requests.json"), bearer(BRIDGE_TOKEN));
    expect(rejected.status).toBe(403);
    expect((await costOf(app, PARALLEL.a)).status).toBe(404);
  });
});
