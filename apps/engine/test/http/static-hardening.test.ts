import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PairingStore } from "../../src/auth/pairing.ts";
import { createApp } from "../../src/http/app.ts";
import { type RunningServer, startServer } from "../../src/http/server.ts";
import { BRIDGE_TOKEN, CLI_TOKEN, HOST, makeApp, ORIGIN } from "./helpers.ts";

const SECRET = "outside the web root";

let root: string;
let webDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "taskville-static-hard-"));
  webDir = join(root, "web");
  mkdirSync(join(webDir, "assets"), { recursive: true });
  mkdirSync(join(root, "outside-dir"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Taskville</title>");
  writeFileSync(join(webDir, "assets", "app-abc123.js"), "console.log('city');");
  writeFileSync(join(webDir, ".env"), "TOKEN=dotfile");
  writeFileSync(join(root, "secret.txt"), SECRET);
  writeFileSync(join(root, "outside-dir", "secret.txt"), SECRET);
  // Escapes through the web directory itself: a file link and a directory link.
  symlinkSync(join(root, "secret.txt"), join(webDir, "link.txt"));
  symlinkSync(join(root, "outside-dir"), join(webDir, "linkdir"));
  // Public-looking names that resolve to hidden files inside the web directory.
  symlinkSync(join(webDir, ".env"), join(webDir, "public.txt"));
  mkdirSync(join(webDir, ".private"));
  writeFileSync(join(webDir, ".private", "key.txt"), "TOKEN=hidden-dir");
  symlinkSync(join(webDir, ".private"), join(webDir, "docs"));
  // A link that stays inside the web directory is harmless and keeps working.
  symlinkSync(join(webDir, "index.html"), join(webDir, "home.html"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("static hosting: file system escapes", () => {
  it("refuses a symlink to a file outside the web directory", async () => {
    const { app } = makeApp({ staticDir: webDir });
    const res = await app.request("/link.txt", { headers: { Host: HOST } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("refuses a path through a symlinked directory that leaves the web directory", async () => {
    const { app } = makeApp({ staticDir: webDir });
    const res = await app.request("/linkdir/secret.txt", { headers: { Host: HOST } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("serves a symlink that resolves inside the web directory", async () => {
    const { app } = makeApp({ staticDir: webDir });
    const res = await app.request("/home.html", { headers: { Host: HOST } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Taskville</title>");
  });

  it("refuses dotfiles", async () => {
    const { app } = makeApp({ staticDir: webDir });
    const res = await app.request("/.env", { headers: { Host: HOST } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("dotfile");
  });

  it("refuses a public symlink that resolves to a hidden file or a hidden directory", async () => {
    const { app } = makeApp({ staticDir: webDir });
    const file = await app.request("/public.txt", { headers: { Host: HOST } });
    expect(file.status).toBe(404);
    expect(await file.text()).not.toContain("dotfile");
    const nested = await app.request("/docs/key.txt", { headers: { Host: HOST } });
    expect(nested.status).toBe(404);
    expect(await nested.text()).not.toContain("hidden-dir");
  });

  it("refuses encoded separators, backslashes, and NUL bytes in the path", async () => {
    const { app } = makeApp({ staticDir: webDir });
    const paths = [
      "/assets/..%2f..%2fsecret.txt",
      "/assets/..%2F..%2Fsecret.txt",
      "/..%2fsecret.txt",
      "/assets/..%5c..%5csecret.txt",
      "/%252e%252e/secret.txt",
      "/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
      "/assets%2f..%2f..%2fsecret.txt",
      "/index.html%00.txt",
      "/%00/../secret.txt",
      "/%ff",
    ];
    for (const path of paths) {
      const res = await app.request(path, { headers: { Host: HOST } });
      expect([400, 404], path).toContain(res.status);
      expect(await res.text(), path).not.toContain(SECRET);
    }
  });

  it("does not list a directory", async () => {
    const { app } = makeApp({ staticDir: webDir });
    const res = await app.request("/assets/", { headers: { Host: HOST } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("app-abc123.js");
  });
});

describe("static hosting: same origin only", () => {
  it("adds no CORS headers and refuses a foreign Origin", async () => {
    const { app } = makeApp({ staticDir: webDir });
    const own = await app.request("/assets/app-abc123.js", { headers: { Host: HOST } });
    expect(own.headers.get("access-control-allow-origin")).toBeNull();
    const foreign = await app.request("/assets/app-abc123.js", {
      headers: { Host: HOST, Origin: "http://evil.example" },
    });
    expect(foreign.status).toBe(403);
  });

  it("sends a same-origin Content-Security-Policy on the page", async () => {
    const { app } = makeApp({ staticDir: webDir });
    const res = await app.request("/", { headers: { Host: HOST } });
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("does not cache the page, and caches fingerprinted assets", async () => {
    const { app } = makeApp({ staticDir: webDir });
    const page = await app.request("/", { headers: { Host: HOST } });
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const asset = await app.request("/assets/app-abc123.js", { headers: { Host: HOST } });
    expect(asset.headers.get("cache-control")).toContain("immutable");
  });

  it("serves only GET and HEAD from the web directory", async () => {
    const { app } = makeApp({ staticDir: webDir });
    const head = await app.request("/", { method: "HEAD", headers: { Host: HOST } });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const post = await app.request("/", {
      method: "POST",
      headers: { Host: HOST, Origin: ORIGIN },
    });
    expect(post.status).toBe(404);
  });

  it("keeps the API closed to an unpaired browser while the page is public", async () => {
    const { app } = makeApp({ staticDir: webDir });
    expect((await app.request("/", { headers: { Host: HOST } })).status).toBe(200);
    for (const path of ["/health", "/v1/projects", "/v1/pairing/revoke"]) {
      const res = await app.request(path, { headers: { Host: HOST } });
      expect(res.status, path).toBe(401);
    }
  });
});

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

/** Sends the request line verbatim, so no client library normalizes `..` away first. */
function rawRequest(port: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.once("error", reject);
    socket.once("close", () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0);
      resolve({ status, body: data.slice(data.indexOf("\r\n\r\n") + 4) });
    });
    socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  });
}

describe("static hosting over a real socket", () => {
  let server: RunningServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("never serves a file outside the web directory, whatever the request line says", async () => {
    const port = await freePort();
    const app = createApp({
      port,
      cliToken: CLI_TOKEN,
      bridgeToken: BRIDGE_TOKEN,
      pairing: new PairingStore(),
      logger: pino({ level: "silent" }),
      staticDir: webDir,
    });
    server = await startServer({ app, port });

    const ok = await rawRequest(port, "/");
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("<title>Taskville</title>");

    const targets = [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/%2E%2E/%2E%2E/secret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/.%2e/secret.txt",
      "/link.txt",
      "/linkdir/secret.txt",
      "//../secret.txt",
      `/${"..%2f".repeat(20)}secret.txt`,
    ];
    for (const target of targets) {
      const res = await rawRequest(port, target);
      expect(res.body, target).not.toContain(SECRET);
    }
  });
});
