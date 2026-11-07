// The page carries the engine's CSP exactly, and every asset is nosniff; bytes stay unchanged.

import { describe, expect, it } from "vitest";
import { PAGE_CSP } from "../../../apps/engine/src/http/static.ts";
import { DEFAULT_FILES, type FakeAsset, makeStaging } from "./support.ts";

const files: Record<string, FakeAsset> = {
  ...DEFAULT_FILES,
  "/docs/about.html": {
    type: "text/html; charset=utf-8",
    bytes: new TextEncoder().encode("<!doctype html><title>about</title>\n"),
  },
  "/assets/style.css": {
    type: "text/css; charset=utf-8",
    bytes: new TextEncoder().encode("a{}\n"),
  },
};

describe("static security headers", () => {
  it("the engine's CSP is a real policy (guards the import)", () => {
    expect(PAGE_CSP).toContain("default-src 'self'");
  });

  for (const path of ["/", "/docs/about.html"]) {
    it(`${path} carries the engine's page CSP exactly and nosniff`, async () => {
      const staging = makeStaging(files);
      const response = await staging.call(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toBe(PAGE_CSP);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const file = files[path === "/" ? "/index.html" : path] as FakeAsset;
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(file.bytes);
    });
  }

  for (const path of ["/assets/index-abc123.js", "/assets/logo.png", "/assets/style.css"]) {
    it(`${path} carries nosniff and its bytes unchanged`, async () => {
      const staging = makeStaging(files);
      const response = await staging.call(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-type")).toBe((files[path] as FakeAsset).type);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        (files[path] as FakeAsset).bytes,
      );
    });
  }

  it("a missing asset is still the binding's 404", async () => {
    const staging = makeStaging(files);
    expect((await staging.call("/assets/missing.js")).status).toBe(404);
  });
});
