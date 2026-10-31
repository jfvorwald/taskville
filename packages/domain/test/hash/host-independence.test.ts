import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  hashCanonical,
  sha256Hex,
  stateHash,
  utf8Encode,
} from "../../src/hash/index.ts";

// Proves the hash module gives the same answers with no host APIs at all: it is
// loaded into a fresh V8 context that has only the ECMAScript built-ins (no
// process, Buffer, TextEncoder, crypto, require, or DOM). A browser offers at
// least those built-ins, so code that runs here runs there. Results are compared
// with the normal Node build and with Web Crypto, the API browsers implement.

const HASH_DIR = join(import.meta.dirname, "../../src/hash");
// Dependency order. index.ts only re-exports.
const SOURCE_FILES = ["sha256.ts", "canonical-json.ts", "state-hash.ts"];

interface Isolated {
  hashFromJson(text: string): string;
  canonicalFromJson(text: string): string;
  stateHashFromJson(version: number, text: string): string;
  sha256Hex(text: string): string;
  hashCanonical(value: unknown): string;
  probeGlobals(): Record<string, string>;
}

function loadIsolated(): Isolated {
  const parts = SOURCE_FILES.map((file) => {
    const js = stripTypeScriptTypes(readFileSync(join(HASH_DIR, file), "utf8"), { mode: "strip" });
    const body = js
      .replace(/^import\s[^;]*;\s*$/gm, "")
      .replace(/^export\s+(?=(?:function|const|class|let)\b)/gm, "");
    if (/^\s*(?:import|export)\b/m.test(body)) {
      throw new Error(`${file}: module syntax the loader does not handle`);
    }
    return body;
  });
  const program = `${parts.join("\n")}
({
  hashFromJson: (t) => hashCanonical(JSON.parse(t)),
  canonicalFromJson: (t) => canonicalJson(JSON.parse(t)),
  stateHashFromJson: (v, t) => stateHash(v, JSON.parse(t)),
  sha256Hex,
  hashCanonical,
  probeGlobals: () => Object.fromEntries(
    ["process", "Buffer", "TextEncoder", "crypto", "require", "window", "setTimeout"]
      .map((n) => [n, typeof globalThis[n]])),
})`;
  return runInContext(program, createContext({})) as Isolated;
}

async function webCryptoHex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", utf8Encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("hash module without host APIs", () => {
  const isolated = loadIsolated();

  it("loads every hash source file", () => {
    const present = readdirSync(HASH_DIR)
      .filter((f) => f.endsWith(".ts") && f !== "index.ts")
      .sort();
    expect(present).toEqual([...SOURCE_FILES].sort());
  });

  it("runs in a context with no Node or browser host globals", () => {
    expect(isolated.probeGlobals()).toEqual({
      process: "undefined",
      Buffer: "undefined",
      TextEncoder: "undefined",
      crypto: "undefined",
      require: "undefined",
      window: "undefined",
      setTimeout: "undefined",
    });
  });

  it("gives the same canonical JSON and hashes as the Node build", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const text = JSON.stringify(value);
        expect(isolated.canonicalFromJson(text)).toBe(canonicalJson(value));
        expect(isolated.hashFromJson(text)).toBe(hashCanonical(value));
        expect(isolated.stateHashFromJson(7, text)).toBe(stateHash(7, value));
      }),
    );
  });

  it("matches the NIST vector for abc", () => {
    expect(isolated.sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("accepts plain objects created in another realm", () => {
    const foreign = runInContext('({ b: [1, { d: 2, c: 3 }], a: "x" })', createContext({}));
    expect(canonicalJson(foreign)).toBe('{"a":"x","b":[1,{"c":3,"d":2}]}');
    expect(isolated.hashCanonical({ b: 1, a: [2] })).toBe(hashCanonical({ a: [2], b: 1 }));
  });
});

describe("agreement with Web Crypto", () => {
  it("SHA-256 of the canonical JSON matches crypto.subtle.digest", async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (value) => {
        const text = canonicalJson(value);
        expect(sha256Hex(text)).toBe(await webCryptoHex(text));
      }),
    );
  });
});
