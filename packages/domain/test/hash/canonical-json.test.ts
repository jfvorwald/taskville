import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalJson } from "../../src/hash/index.ts";

describe("canonicalJson: structure", () => {
  it("sorts object keys and writes no whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 0, y: {} } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":{},"z":0}}',
    );
  });

  it("serializes scalars and empty containers", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson("")).toBe('""');
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson({})).toBe("{}");
  });

  it("preserves array order, including nested arrays", () => {
    expect(canonicalJson([3, [2, [1, 0]], { b: [9, 8], a: [] }])).toBe(
      '[3,[2,[1,0]],{"a":[],"b":[9,8]}]',
    );
  });

  it("sorts keys by UTF-16 code unit order, not code point or locale order", () => {
    // U+1F600 is the pair D83D DE00, which sorts before U+FFFF in UTF-16 code
    // units but after it in code point order. "B" (0x42) sorts before "a" (0x61).
    const value = { "￿": 1, "\u{1f600}": 2, a: 3, B: 4, "": 5, aa: 6, "é": 7 };
    expect(canonicalJson(value)).toBe(
      '{"":5,"B":4,"a":3,"aa":6,"é":7,"\u{1f600}":2,"￿":1}',
    );
  });

  it("treats an own __proto__ key as an ordinary key", () => {
    const value = JSON.parse('{"__proto__":{"x":1},"a":2}') as unknown;
    expect(canonicalJson(value)).toBe('{"__proto__":{"x":1},"a":2}');
  });

  it("accepts null-prototype objects", () => {
    const value = Object.assign(Object.create(null) as object, { b: 2, a: 1 });
    expect(canonicalJson(value)).toBe('{"a":1,"b":2}');
  });

  it("allows the same object to appear twice when it is not a cycle", () => {
    const shared = { k: 1 };
    expect(canonicalJson({ a: shared, b: [shared, shared] })).toBe(
      '{"a":{"k":1},"b":[{"k":1},{"k":1}]}',
    );
  });
});

describe("canonicalJson: undefined", () => {
  it("omits object properties whose value is undefined", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson({ a: undefined })).toBe(canonicalJson({}));
  });

  it("rejects undefined at the top level and inside arrays", () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson([1, undefined])).toThrow(CanonicalJsonError);
  });

  it("rejects array holes", () => {
    // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test
    expect(() => canonicalJson([1, , 3])).toThrow(CanonicalJsonError);
  });
});

describe("canonicalJson: numbers", () => {
  it("writes numbers the way ECMAScript Number-to-string does (RFC 8785)", () => {
    expect(canonicalJson([0, 1, -1, 1.5, 1e21, 1e-7, 0.000001, 123456789012345680000])).toBe(
      "[0,1,-1,1.5,1e+21,1e-7,0.000001,123456789012345680000]",
    );
    expect(canonicalJson(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    expect(canonicalJson(5e-324)).toBe("5e-324");
  });

  it("normalizes -0 to 0", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson({ a: -0 })).toBe(canonicalJson({ a: 0 }));
  });

  it("rejects non-finite numbers", () => {
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => canonicalJson(n)).toThrow(CanonicalJsonError);
      expect(() => canonicalJson({ a: [n] })).toThrow(CanonicalJsonError);
    }
  });
});

describe("canonicalJson: strings", () => {
  it("escapes quote, backslash and control characters, lowercase hex", () => {
    expect(canonicalJson('"\\\b\f\n\r\t\u0000\u001f\u007f')).toBe(
      '"\\"\\\\\\b\\f\\n\\r\\t\\u0000\\u001f\u007f"',
    );
  });

  it("writes non-ASCII characters as themselves, not as escapes", () => {
    expect(canonicalJson("é€\u{1f600}  ")).toBe(
      '"é€\u{1f600}  "',
    );
  });

  it("does not normalize Unicode: NFC and NFD forms stay distinct", () => {
    expect(canonicalJson("é")).not.toBe(canonicalJson("é"));
  });

  it("rejects lone surrogates in values and in keys", () => {
    expect(() => canonicalJson("\ud800")).toThrow(CanonicalJsonError);
    expect(() => canonicalJson("a\udc00b")).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ "\ud83d": 1 })).toThrow(CanonicalJsonError);
  });
});

describe("canonicalJson: rejected values", () => {
  class Thing {
    a = 1;
  }
  const cases: [string, unknown][] = [
    ["bigint", 1n],
    ["symbol", Symbol("s")],
    ["function", () => 1],
    ["Date", new Date(0)],
    ["Map", new Map()],
    ["Set", new Set()],
    ["RegExp", /x/],
    ["class instance", new Thing()],
    ["Uint8Array", new Uint8Array(2)],
    ["boxed string", Object("s")],
    ["Error", new Error("e")],
    ["object with a symbol key", { [Symbol("k")]: 1 }],
    ["nested function", { a: { b: [() => 1] } }],
  ];
  for (const [name, value] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
    });
  }

  it("rejects cycles", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(CanonicalJsonError);
    const arr: unknown[] = [];
    arr.push([arr]);
    expect(() => canonicalJson(arr)).toThrow(CanonicalJsonError);
  });

  it("reports the path of the offending value", () => {
    expect(() => canonicalJson({ a: [0, { b: Number.NaN }] })).toThrow(/\$\.a\[1\]\.b/);
  });
});

describe("canonicalJson: properties", () => {
  it("round-trips through JSON.parse to an equal value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const text = canonicalJson(value);
        // toEqual treats -0 and 0 as different; canonical JSON normalizes -0.
        expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(value)));
      }),
    );
  });

  it("is a fixed point: canonicalizing parsed canonical output changes nothing", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const text = canonicalJson(value);
        expect(canonicalJson(JSON.parse(text))).toBe(text);
      }),
    );
  });

  it("matches JSON.stringify for values with no keys to sort", () => {
    const leaf = fc.oneof(
      fc.constant(null),
      fc.boolean(),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.string({ unit: "grapheme" }),
    );
    const arrays = fc.letrec((tie) => ({
      node: fc.oneof({ depthSize: "small" }, leaf, fc.array(tie("node"))),
    })).node;
    fc.assert(
      fc.property(arrays, (value) => {
        expect(canonicalJson(value)).toBe(JSON.stringify(value));
      }),
    );
  });
});
