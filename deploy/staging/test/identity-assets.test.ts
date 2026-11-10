// Staging identity on /health (M7.26 #421 shape) and static assets served unchanged.

import { describe, expect, it } from "vitest";
import { DEFAULT_FILES, makeStaging, pair, RELEASE_ID, withSession } from "./support.ts";

describe("GET /health", () => {
  it("reports the staging release identity with the id the deploy provides", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const response = await staging.call("/health", withSession(session));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; release: Record<string, unknown> };
    expect(body.status).toBe("ok");
    expect(body.release).toEqual({
      id: RELEASE_ID,
      version: expect.stringMatching(/\S/),
      environment: "staging",
    });
  });

  it("takes the release id from the env, not a constant", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const env = { ...staging.env, RELEASE_ID: "another-release-id" };
    const response = await staging.worker.fetch(
      new Request("https://taskville-staging.jaqstudios.com/health", withSession(session)),
      env as never,
    );
    const body = (await response.json()) as { release: { id: string } };
    expect(body.release.id).toBe("another-release-id");
  });
});

describe("static assets", () => {
  for (const [path, file] of Object.entries(DEFAULT_FILES)) {
    const url = path === "/index.html" ? "/" : path;
    it(`serves ${url} byte-identical to the ASSETS binding`, async () => {
      const staging = makeStaging();
      const response = await staging.call(url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(file.type);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(file.bytes);
      expect(staging.assets.fetch).toHaveBeenCalledTimes(1);
    });
  }

  it("needs no session for the app shell (Access guards it; pairing starts in the app)", async () => {
    const staging = makeStaging();
    expect((await staging.call("/")).status).toBe(200);
  });

  it("passes an asset the binding does not have through as its 404", async () => {
    const staging = makeStaging();
    expect((await staging.call("/assets/missing.js")).status).toBe(404);
  });

  it("never asks ASSETS for the Worker's own routes", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    await staging.call("/health", withSession(session));
    await staging.call("/v1/projects", withSession(session));
    await staging.call("/pair");
    expect(staging.assets.fetch).not.toHaveBeenCalled();
  });
});
