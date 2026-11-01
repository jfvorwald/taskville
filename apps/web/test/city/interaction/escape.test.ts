import { describe, expect, it } from "vitest";
import { shouldClearOnEscape } from "../../../src/city/interaction/escape.ts";

interface FakeTarget {
  tagName: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

function target(over: Partial<FakeTarget> = {}): FakeTarget {
  return { tagName: "CANVAS", isContentEditable: false, closest: () => null, ...over };
}

function key(over: { key?: string; defaultPrevented?: boolean; target?: FakeTarget | null } = {}) {
  return {
    key: "Escape",
    defaultPrevented: false,
    target: target(),
    ...over,
  } as unknown as Parameters<typeof shouldClearOnEscape>[0];
}

describe("shouldClearOnEscape", () => {
  it("clears for Escape on the canvas or the page", () => {
    expect(shouldClearOnEscape(key())).toBe(true);
    expect(shouldClearOnEscape(key({ target: target({ tagName: "BODY" }) }))).toBe(true);
    expect(shouldClearOnEscape(key({ target: null }))).toBe(true);
  });

  it("ignores other keys", () => {
    expect(shouldClearOnEscape(key({ key: "Enter" }))).toBe(false);
    expect(shouldClearOnEscape(key({ key: "a" }))).toBe(false);
  });

  it("ignores an Escape something else already handled", () => {
    expect(shouldClearOnEscape(key({ defaultPrevented: true }))).toBe(false);
  });

  it.each(["INPUT", "TEXTAREA", "SELECT"])("leaves Escape alone inside a %s", (tagName) => {
    expect(shouldClearOnEscape(key({ target: target({ tagName }) }))).toBe(false);
  });

  it("leaves Escape alone inside a contenteditable element", () => {
    expect(
      shouldClearOnEscape(key({ target: target({ tagName: "DIV", isContentEditable: true }) })),
    ).toBe(false);
  });

  it("leaves Escape alone inside a dialog", () => {
    const inDialog = target({
      tagName: "BUTTON",
      closest: (selector) => (selector.includes("dialog") ? {} : null),
    });
    expect(shouldClearOnEscape(key({ target: inDialog }))).toBe(false);
  });
});
