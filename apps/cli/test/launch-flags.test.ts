// The engine needs V8's semi-spaces capped at launch to keep resident memory flat (#166, M7.14).
// `pnpm perf:unit` is outside `pnpm check`, so this guard keeps the documented launch honest.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");

describe("taskville launch flags (#166)", () => {
  it("the root taskville script launches node with --max-semi-space-size=8", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    const words = String(pkg.scripts.taskville).split(/\s+/);
    expect(words[0]).toBe("node");
    const script = words.findIndex((w) => !w.startsWith("--") && w !== "node");
    expect(words.slice(1, script)).toContain("--max-semi-space-size=8");
  });
});
