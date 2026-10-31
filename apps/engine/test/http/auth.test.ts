import { describe, expect, it } from "vitest";
import { requireScope } from "../../src/http/app.ts";
import {
  BRIDGE_TOKEN,
  bearer,
  CLI_TOKEN,
  HOST,
  makeApp,
  ORIGIN,
  postJson,
  sessionHeaders,
} from "./helpers.ts";

async function pair(app: ReturnType<typeof makeApp>["app"], code: string): Promise<string> {
  const res = await app.request(
    "/v1/pairing/exchange",
    postJson({ code }, { Host: HOST, Origin: ORIGIN }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { session: string };
  return body.session;
}

describe("credentials on reads", () => {
  it("rejects GET /health with no credentials", async () => {
    const { app } = makeApp();
    const res = await app.request("/health", { headers: { Host: HOST } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
  });

  it("rejects a wrong bearer token", async () => {
    const { app } = makeApp();
    const res = await app.request("/health", { headers: bearer(`${CLI_TOKEN}x`) });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed Authorization header", async () => {
    const { app } = makeApp();
    for (const value of [CLI_TOKEN, `Basic ${CLI_TOKEN}`, "Bearer", "Bearer "]) {
      const res = await app.request("/health", { headers: { Host: HOST, Authorization: value } });
      expect(res.status, value).toBe(401);
    }
  });

  it("rejects an unknown session secret", async () => {
    const { app } = makeApp();
    const res = await app.request("/health", { headers: sessionHeaders("guessed-session") });
    expect(res.status).toBe(401);
  });

  it("rejects a request carrying both a bearer token and a session", async () => {
    const { app, pairing } = makeApp();
    const session = await pair(app, pairing.issueCode());
    const res = await app.request("/health", {
      headers: { ...bearer(CLI_TOKEN), "X-Taskville-Session": session },
    });
    expect(res.status).toBe(401);
  });

  it("serves GET /health to the CLI token and to a paired session", async () => {
    const { app, pairing } = makeApp();
    const cli = await app.request("/health", { headers: bearer(CLI_TOKEN) });
    expect(cli.status).toBe(200);
    expect(await cli.json()).toMatchObject({ status: "ok" });
    const session = await pair(app, pairing.issueCode());
    const browser = await app.request("/health", { headers: sessionHeaders(session) });
    expect(browser.status).toBe(200);
  });

  it("refuses the bridge token outside the bridge", async () => {
    const { app } = makeApp();
    const res = await app.request("/health", { headers: bearer(BRIDGE_TOKEN) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "forbidden", message: expect.any(String) },
    });
  });

  it("requires credentials on unknown API paths instead of revealing a 404", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/whatever", { headers: { Host: HOST } });
    expect(res.status).toBe(401);
  });
});

describe("browser pairing", () => {
  it("accepts a pairing code once", async () => {
    const { app, pairing } = makeApp();
    const code = pairing.issueCode();
    await pair(app, code);
    const again = await app.request(
      "/v1/pairing/exchange",
      postJson({ code }, { Host: HOST, Origin: ORIGIN }),
    );
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({
      error: { code: "invalid_pairing_code", message: expect.any(String) },
    });
  });

  it("requires a matching Origin on the exchange", async () => {
    const { app, pairing } = makeApp();
    const code = pairing.issueCode();
    const none = await app.request("/v1/pairing/exchange", postJson({ code }, { Host: HOST }));
    expect(none.status).toBe(403);
    const foreign = await app.request(
      "/v1/pairing/exchange",
      postJson({ code }, { Host: HOST, Origin: "http://evil.example" }),
    );
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({
      error: { code: "forbidden_origin", message: expect.any(String) },
    });
    // Neither rejected attempt consumed the code.
    await pair(app, code);
  });

  it("rejects a malformed exchange body without echoing it", async () => {
    const { app } = makeApp();
    for (const body of [{}, { code: 42 }, { code: "" }, { code: "x".repeat(1000) }, "nope"]) {
      const res = await app.request(
        "/v1/pairing/exchange",
        postJson(body, { Host: HOST, Origin: ORIGIN }),
      );
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.text()).not.toContain("xxxxxxxx");
    }
  });

  it("does not reveal the code or session in error bodies or response headers", async () => {
    const { app, pairing } = makeApp();
    const code = pairing.issueCode();
    await pair(app, code);
    const res = await app.request(
      "/v1/pairing/exchange",
      postJson({ code }, { Host: HOST, Origin: ORIGIN }),
    );
    expect(await res.text()).not.toContain(code);
  });

  it("marks API responses no-store and never sets cookies", async () => {
    const { app, pairing } = makeApp();
    const res = await app.request(
      "/v1/pairing/exchange",
      postJson({ code: pairing.issueCode() }, { Host: HOST, Origin: ORIGIN }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("unpair (CLI token) revokes every paired session", async () => {
    const { app, pairing } = makeApp();
    const a = await pair(app, pairing.issueCode());
    const b = await pair(app, pairing.issueCode());
    const res = await app.request("/v1/pairing/unpair", {
      method: "POST",
      headers: bearer(CLI_TOKEN),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 2 });
    for (const s of [a, b]) {
      const after = await app.request("/health", { headers: sessionHeaders(s) });
      expect(after.status).toBe(401);
    }
  });

  it("unpair is refused to a browser session and to the bridge", async () => {
    const { app, pairing } = makeApp();
    const session = await pair(app, pairing.issueCode());
    const fromBrowser = await app.request("/v1/pairing/unpair", {
      method: "POST",
      headers: { ...sessionHeaders(session), Origin: ORIGIN },
    });
    expect(fromBrowser.status).toBe(403);
    const fromBridge = await app.request("/v1/pairing/unpair", {
      method: "POST",
      headers: bearer(BRIDGE_TOKEN),
    });
    expect(fromBridge.status).toBe(403);
  });

  it("offers no HTTP route that mints a pairing code", async () => {
    const { app } = makeApp();
    for (const path of ["/v1/pairing", "/v1/pairing/code", "/v1/pairing/issue"]) {
      const res = await app.request(path, { method: "POST", headers: bearer(CLI_TOKEN) });
      expect(res.status, path).toBe(404);
    }
  });
});

describe("command route stub", () => {
  function appWithCommands() {
    const made = makeApp();
    made.app.post("/v1/commands", requireScope("command"), (c) => c.json({ accepted: true }));
    return made;
  }

  it("refuses the CLI token", async () => {
    const { app } = appWithCommands();
    const res = await app.request("/v1/commands", postJson({}, bearer(CLI_TOKEN)));
    expect(res.status).toBe(403);
  });

  it("refuses the CLI token even with a matching Origin", async () => {
    const { app } = appWithCommands();
    const res = await app.request(
      "/v1/commands",
      postJson({}, { ...bearer(CLI_TOKEN), Origin: ORIGIN }),
    );
    expect(res.status).toBe(403);
  });

  it("refuses the bridge token", async () => {
    const { app } = appWithCommands();
    const res = await app.request("/v1/commands", postJson({}, bearer(BRIDGE_TOKEN)));
    expect(res.status).toBe(403);
  });

  it("refuses a request with no credentials", async () => {
    const { app } = appWithCommands();
    const res = await app.request("/v1/commands", postJson({}, { Host: HOST, Origin: ORIGIN }));
    expect(res.status).toBe(401);
  });

  it("accepts a paired session with a matching Origin", async () => {
    const { app, pairing } = appWithCommands();
    const session = await pair(app, pairing.issueCode());
    const res = await app.request(
      "/v1/commands",
      postJson({}, { ...sessionHeaders(session), Origin: ORIGIN }),
    );
    expect(res.status).toBe(200);
  });

  it("refuses a paired session with no Origin or a foreign Origin", async () => {
    const { app, pairing } = appWithCommands();
    const session = await pair(app, pairing.issueCode());
    const none = await app.request("/v1/commands", postJson({}, sessionHeaders(session)));
    expect(none.status).toBe(403);
    const foreign = await app.request(
      "/v1/commands",
      postJson({}, { ...sessionHeaders(session), Origin: "http://localhost:3000" }),
    );
    expect(foreign.status).toBe(403);
  });

  it("refuses a revoked session", async () => {
    const { app, pairing } = appWithCommands();
    const session = await pair(app, pairing.issueCode());
    pairing.unpairAll();
    const res = await app.request(
      "/v1/commands",
      postJson({}, { ...sessionHeaders(session), Origin: ORIGIN }),
    );
    expect(res.status).toBe(401);
  });
});

describe("Origin on reads", () => {
  it("rejects a read carrying a foreign Origin", async () => {
    const { app } = makeApp();
    const res = await app.request("/health", {
      headers: { ...bearer(CLI_TOKEN), Origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("does not answer a CORS preflight with allow headers", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/commands", {
      method: "OPTIONS",
      headers: {
        Host: HOST,
        Origin: "http://evil.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-taskville-session",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
  });
});

describe("logs", () => {
  it("never contain tokens, pairing codes, or session secrets", async () => {
    const { app, pairing, logLines } = makeApp();
    const code = pairing.issueCode();
    const session = await pair(app, code);
    await app.request("/v1/pairing/exchange", postJson({ code }, { Host: HOST, Origin: ORIGIN }));
    await app.request("/health", { headers: bearer(CLI_TOKEN) });
    await app.request("/health", { headers: bearer(`${BRIDGE_TOKEN}`) });
    await app.request("/health", { headers: sessionHeaders(session) });
    await app.request("/health", { headers: bearer("wrong-token-value-abc") });
    expect(logLines.length).toBeGreaterThan(0);
    const all = logLines.join("\n");
    for (const secret of [CLI_TOKEN, BRIDGE_TOKEN, code, session, "wrong-token-value-abc"]) {
      expect(all).not.toContain(secret);
    }
  });
});
