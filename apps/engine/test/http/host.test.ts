import { describe, expect, it } from "vitest";
import { BRIDGE_TOKEN, CLI_TOKEN, makeApp, ORIGIN, PORT, postJson } from "./helpers.ts";

const BAD_HOSTS = [
  "evil.example:4807",
  "evil.example",
  "127.0.0.1",
  "127.0.0.1:4808",
  "127.0.0.1.evil.example:4807",
  "0.0.0.0:4807",
  "[::1]:4807",
  `localhost:${PORT}0`,
];

describe("Host check (DNS rebinding)", () => {
  for (const host of BAD_HOSTS) {
    it(`rejects GET with Host ${host} even with a valid token`, async () => {
      const { app } = makeApp();
      const res = await app.request("/health", {
        headers: { Host: host, Authorization: `Bearer ${CLI_TOKEN}` },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: { code: "forbidden_host", message: expect.any(String) },
      });
    });

    it(`rejects POST with Host ${host}`, async () => {
      const { app, pairing } = makeApp();
      const code = pairing.issueCode();
      const res = await app.request(
        "/v1/pairing",
        postJson({ code }, { Host: host, Origin: ORIGIN }),
      );
      expect(res.status).toBe(403);
      // The rejected request must not have consumed the code.
      expect(pairing.exchange(code)).not.toBeNull();
    });
  }

  it("rejects a request with no Host header", async () => {
    const { app } = makeApp();
    const res = await app.request("/health", {
      headers: { Authorization: `Bearer ${CLI_TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a bad Host on routes added after createApp", async () => {
    const { app } = makeApp();
    app.post("/v1/bridge/claude-code/permission", (c) => c.json({ ok: true }));
    const res = await app.request("/v1/bridge/claude-code/permission", {
      method: "POST",
      headers: { Host: "evil.example:4807", Authorization: `Bearer ${BRIDGE_TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a bad Host on unknown paths before revealing a 404", async () => {
    const { app } = makeApp();
    const res = await app.request("/nope", { headers: { Host: "evil.example:4807" } });
    expect(res.status).toBe(403);
  });

  it("accepts the loopback host and port, by IP or as localhost, in any case", async () => {
    const { app } = makeApp();
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `LocalHost:${PORT}`]) {
      const res = await app.request("/health", {
        headers: { Host: host, Authorization: `Bearer ${CLI_TOKEN}` },
      });
      expect(res.status, host).toBe(200);
    }
  });
});
