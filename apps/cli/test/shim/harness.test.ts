// The stand-in engine records only curl's requests in `received`; probes from
// other local processes (T3 Code sends `GET /` with User-Agent `node`) go to
// `foreign` (M4.12). Pins that filter so the shim tests cannot drift.

import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./harness.ts";

type Server = Awaited<ReturnType<typeof startServer>>;

function send(server: Server, userAgent: string, method = "GET", path = "/"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: server.port, method, path, headers: { "user-agent": userAgent } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("shim test stand-in server", () => {
  let server: Server;

  afterEach(async () => {
    await server.close();
  });

  it("keeps a node-UA probe out of received and records it as foreign", async () => {
    server = await startServer();
    expect(await send(server, "node")).toBe(202);
    expect(server.received).toHaveLength(0);
    expect(server.foreign).toHaveLength(1);
    expect(server.foreign[0]?.method).toBe("GET");
    expect(server.foreign[0]?.url).toBe("/");
  });

  it("records a curl-UA request in received, not foreign", async () => {
    server = await startServer();
    expect(await send(server, "curl/8.7.1", "POST", "/v1/events")).toBe(202);
    expect(server.received).toHaveLength(1);
    expect(server.received[0]?.url).toBe("/v1/events");
    expect(server.foreign).toHaveLength(0);
  });
});
