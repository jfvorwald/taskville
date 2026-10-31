import { request } from "node:http";
import { createServer } from "node:net";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { PairingStore } from "../../src/auth/pairing.ts";
import { createApp } from "../../src/http/app.ts";
import { startServer } from "../../src/http/server.ts";
import { BRIDGE_TOKEN, CLI_TOKEN } from "./helpers.ts";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      srv.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function rawGet(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/health", method: "GET", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.once("error", reject);
    req.end();
  });
}

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("startServer (real socket)", () => {
  it("binds 127.0.0.1 only and enforces Host and token over the wire", async () => {
    const port = await freePort();
    const app = createApp({
      port,
      cliToken: CLI_TOKEN,
      bridgeToken: BRIDGE_TOKEN,
      pairing: new PairingStore(),
      logger: pino({ level: "silent" }),
    });
    const server = await startServer({ app, port });
    close = server.close;
    expect(server.address).toBe("127.0.0.1");
    expect(server.port).toBe(port);

    const auth = { Authorization: `Bearer ${CLI_TOKEN}` };
    expect(await rawGet(port, { ...auth, Host: `127.0.0.1:${port}` })).toBe(200);
    expect(await rawGet(port, { ...auth, Host: `evil.example:${port}` })).toBe(403);
    expect(await rawGet(port, { Host: `127.0.0.1:${port}` })).toBe(401);
  });
});
