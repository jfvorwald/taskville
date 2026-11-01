import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeServe } from "../../src/commands/serve.ts";
import { freePort, tempDir } from "../helpers.ts";

// M3.01 (#26): the engine serves the built web client on its own port, same origin.

describe("serve hosts the web client", () => {
  it("serves index.html from TASKVILLE_WEB_DIR at / and keeps the API closed", async () => {
    const home = tempDir();
    const web = tempDir("taskville-web-");
    try {
      writeFileSync(join(web.path, "index.html"), "<!doctype html><title>Taskville</title>");
      const port = await freePort();
      const parts = composeServe(
        {
          stdout: () => {},
          stderr: () => {},
          env: { TASKVILLE_WEB_DIR: web.path },
          cwd: home.path,
        },
        home.path,
        port,
      );
      try {
        const host = { Host: `127.0.0.1:${port}` };
        const page = await parts.app.request("/", { headers: host });
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("<title>Taskville</title>");
        expect((await parts.app.request("/health", { headers: host })).status).toBe(401);
        expect((await parts.app.request("/v1/projects", { headers: host })).status).toBe(401);
      } finally {
        await parts.close();
      }
    } finally {
      home.remove();
      web.remove();
    }
  });

  it("warns once on stderr and serves no page when the web client is not built", async () => {
    const home = tempDir();
    const web = tempDir("taskville-web-");
    const err: string[] = [];
    try {
      const port = await freePort();
      const parts = composeServe(
        {
          stdout: () => {},
          stderr: (text) => err.push(text),
          env: { TASKVILLE_WEB_DIR: join(web.path, "missing") },
          cwd: home.path,
        },
        home.path,
        port,
      );
      try {
        const res = await parts.app.request("/", { headers: { Host: `127.0.0.1:${port}` } });
        expect(res.status).toBe(404);
        expect(err.join("")).toContain("web client is not built");
      } finally {
        await parts.close();
      }
    } finally {
      home.remove();
      web.remove();
    }
  });
});
