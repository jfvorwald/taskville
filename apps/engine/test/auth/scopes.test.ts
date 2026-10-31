import { describe, expect, it } from "vitest";
import { allows } from "../../src/auth/scopes.ts";

describe("credential scopes", () => {
  it("only a paired browser session may send commands", () => {
    expect(allows("session", "command")).toBe(true);
    expect(allows("cli", "command")).toBe(false);
    expect(allows("bridge", "command")).toBe(false);
  });

  it("only the bridge token may use the permission bridge", () => {
    expect(allows("bridge", "bridge")).toBe(true);
    expect(allows("cli", "bridge")).toBe(false);
    expect(allows("session", "bridge")).toBe(false);
  });

  it("the CLI and shim token ingests; the browser and bridge do not", () => {
    expect(allows("cli", "ingest")).toBe(true);
    expect(allows("session", "ingest")).toBe(false);
    expect(allows("bridge", "ingest")).toBe(false);
  });

  it("the CLI and the browser read; the bridge does not", () => {
    expect(allows("cli", "read")).toBe(true);
    expect(allows("session", "read")).toBe(true);
    expect(allows("bridge", "read")).toBe(false);
  });

  it("only the CLI may unpair browsers", () => {
    expect(allows("cli", "unpair")).toBe(true);
    expect(allows("session", "unpair")).toBe(false);
    expect(allows("bridge", "unpair")).toBe(false);
  });
});
