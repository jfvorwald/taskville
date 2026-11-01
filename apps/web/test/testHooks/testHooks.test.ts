import { afterEach, describe, expect, it, vi } from "vitest";

import { fixtureRequested } from "../../src/city/interaction/fixture.ts";
import { debugHookRequested, testHooksEnabled } from "../../src/testHooks.ts";

// M3.19: the URL-triggered test hooks exist only in builds made with VITE_TV_TEST_HOOKS=1.
// The flag is read from import.meta.env at call time, so vi.stubEnv drives both states.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("testHooksEnabled", () => {
  it("is off when the flag is unset", () => {
    vi.stubEnv("VITE_TV_TEST_HOOKS", "");
    expect(testHooksEnabled()).toBe(false);
  });

  it("is on only for the exact value 1", () => {
    vi.stubEnv("VITE_TV_TEST_HOOKS", "1");
    expect(testHooksEnabled()).toBe(true);
    for (const other of ["0", "true", "yes", " 1"]) {
      vi.stubEnv("VITE_TV_TEST_HOOKS", other);
      expect(testHooksEnabled()).toBe(false);
    }
  });

  it("reads an injected env instead of import.meta.env", () => {
    vi.stubEnv("VITE_TV_TEST_HOOKS", "1");
    expect(testHooksEnabled({})).toBe(false);
    expect(testHooksEnabled({ VITE_TV_TEST_HOOKS: "1" })).toBe(true);
    vi.stubEnv("VITE_TV_TEST_HOOKS", "");
    expect(testHooksEnabled({ VITE_TV_TEST_HOOKS: "1" })).toBe(true);
  });
});

describe("?tv-fixture=agents (fixtureRequested)", () => {
  it("does not enable the fixture when the flag is unset", () => {
    vi.stubEnv("VITE_TV_TEST_HOOKS", "");
    expect(fixtureRequested("?tv-fixture=agents")).toBe(false);
  });

  it("enables the fixture when the flag is set", () => {
    vi.stubEnv("VITE_TV_TEST_HOOKS", "1");
    expect(fixtureRequested("?tv-fixture=agents")).toBe(true);
  });

  it("still requires the exact parameter value when the flag is set", () => {
    vi.stubEnv("VITE_TV_TEST_HOOKS", "1");
    expect(fixtureRequested("")).toBe(false);
    expect(fixtureRequested("?tv-fixture=other")).toBe(false);
  });
});

describe.each([
  ["movement", "?debug=movement", "?debug=celebrations"],
  ["celebrations", "?debug=celebrations", "?debug=movement"],
] as const)("?debug=%s (debugHookRequested)", (hook, search, otherSearch) => {
  it("does not enable the hook when the flag is unset", () => {
    vi.stubEnv("VITE_TV_TEST_HOOKS", "");
    expect(debugHookRequested(search, hook)).toBe(false);
  });

  it("enables the hook when the flag is set", () => {
    vi.stubEnv("VITE_TV_TEST_HOOKS", "1");
    expect(debugHookRequested(search, hook)).toBe(true);
  });

  it("still requires its own parameter value when the flag is set", () => {
    vi.stubEnv("VITE_TV_TEST_HOOKS", "1");
    expect(debugHookRequested("", hook)).toBe(false);
    expect(debugHookRequested(otherSearch, hook)).toBe(false);
  });

  it("honors an injected env", () => {
    expect(debugHookRequested(search, hook, {})).toBe(false);
    expect(debugHookRequested(search, hook, { VITE_TV_TEST_HOOKS: "1" })).toBe(true);
  });
});
