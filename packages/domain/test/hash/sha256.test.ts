import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sha256, sha256Hex, utf8Encode } from "../../src/hash/index.ts";

// node:crypto is used only here, as a reference to compare against. src never imports it.
const nodeHex = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

describe("sha256: NIST test vectors (FIPS 180-2 appendix B, NIST CAVS examples)", () => {
  const vectors: [string, string, string][] = [
    ["empty string", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc (one block)", "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "448-bit message (two blocks)",
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
    [
      "896-bit message",
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
      "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
    ],
    [
      "one million 'a'",
      "a".repeat(1_000_000),
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    ],
  ];
  for (const [name, message, digest] of vectors) {
    it(name, () => {
      expect(sha256Hex(message)).toBe(digest);
      expect(toHex(sha256(utf8Encode(message)))).toBe(digest);
    });
  }

  it("returns a 32-byte digest", () => {
    expect(sha256(new Uint8Array(0))).toHaveLength(32);
  });
});

describe("sha256: agreement with node:crypto", () => {
  it("matches at every length around the padding boundaries", () => {
    for (let n = 0; n <= 200; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff);
      expect(toHex(sha256(bytes))).toBe(nodeHex(bytes));
    }
  });

  it("matches for arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 1024 }), (bytes) => {
        expect(toHex(sha256(bytes))).toBe(nodeHex(bytes));
      }),
    );
  });

  it("matches for arbitrary well-formed Unicode strings, hashed as UTF-8", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 200 }), (text) => {
        expect(sha256Hex(text)).toBe(nodeHex(text));
      }),
    );
  });
});

describe("utf8Encode", () => {
  it("matches node's UTF-8 encoder for well-formed strings", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 200 }), (text) => {
        expect(Array.from(utf8Encode(text))).toEqual(Array.from(Buffer.from(text, "utf8")));
      }),
    );
  });

  it("encodes 1-, 2-, 3- and 4-byte sequences", () => {
    expect(Array.from(utf8Encode("A\u00e9\u20ac\u{1f600}"))).toEqual([
      0x41, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80,
    ]);
  });

  it("rejects lone surrogates instead of silently replacing them", () => {
    expect(() => utf8Encode("\ud800")).toThrow(TypeError);
    expect(() => utf8Encode("x\udfffy")).toThrow(TypeError);
    expect(() => sha256Hex("\ud83d")).toThrow(TypeError);
  });
});
