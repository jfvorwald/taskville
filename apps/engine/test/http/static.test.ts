import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_TOKEN, HOST, makeApp } from "./helpers.ts";

let root: string;
let webDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "taskville-static-"));
  webDir = join(root, "web");
  mkdirSync(join(webDir, "assets"), { recursive: true });
  mkdirSync(join(webDir, "v1"), { recursive: true });
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Taskville</title>");
  writeFileSync(join(webDir, "assets", "app.js"), "console.log('city');");
  writeFileSync(join(webDir, "v1", "projects"), "shadowed");
  writeFileSync(join(root, "secret.txt"), "outside the web root");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("static web client", () => {
  it("serves index.html at / without credentials, so the page can pair", async () => {
    const { app } = makeApp({ staticDir: webDir });
    const res = await app.request("/", { headers: { Host: HOST } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>Taskville</title>");
  });

  it("serves assets with a content type", async () => {
    const { app } = makeApp({ staticDir: webDir });
    const res = await app.request("/assets/app.js", { headers: { Host: HOST } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("still applies the Host check to static files", async () => {
    const { app } = makeApp({ staticDir: webDir });
    const res = await app.request("/", { headers: { Host: "evil.example:4807" } });
    expect(res.status).toBe(403);
  });

  it("does not serve files outside the static directory", async () => {
    const { app } = makeApp({ staticDir: webDir });
    for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
      const res = await app.request(path, { headers: { Host: HOST } });
      expect(await res.text(), path).not.toContain("outside the web root");
    }
  });

  it("never lets a static file shadow an API path", async () => {
    const { app } = makeApp({ staticDir: webDir });
    const res = await app.request("/v1/projects", { headers: { Host: HOST } });
    expect(res.status).toBe(401);
    const authed = await app.request("/v1/projects", {
      headers: { Host: HOST, Authorization: `Bearer ${CLI_TOKEN}` },
    });
    expect(await authed.text()).not.toContain("shadowed");
  });

  it("returns 404 for a missing file", async () => {
    const { app } = makeApp({ staticDir: webDir });
    const res = await app.request("/missing.js", { headers: { Host: HOST } });
    expect(res.status).toBe(404);
  });
});
