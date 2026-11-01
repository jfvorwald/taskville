import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CITY_LAYOUT } from "../../../src/city/layout/index.ts";
import { validateAccents, validateTheme } from "../../../src/themes/core/contract.ts";
import { THEMES } from "../../../src/themes/core/themes.ts";

const THEMES_DIR = fileURLToPath(new URL("../../../src/themes/", import.meta.url));

describe("theme registry", () => {
  it("registers at least one theme", () => {
    expect(THEMES.length).toBeGreaterThan(0);
  });

  it.each(THEMES.map((t) => [t.id, t] as const))("%s passes the contract checks", (_id, theme) => {
    expect(validateTheme(theme)).toEqual([]);
    expect(validateAccents(CITY_LAYOUT, theme.accents)).toEqual([]);
  });

  it("theme modules never import core/index.ts (it would cycle through the registry)", () => {
    const themeDirs = readdirSync(THEMES_DIR).filter(
      (name) => name !== "core" && statSync(join(THEMES_DIR, name)).isDirectory(),
    );
    expect(themeDirs).toContain("cyberpunk");
    for (const dir of themeDirs) {
      const source = readFileSync(join(THEMES_DIR, dir, "index.ts"), "utf8");
      expect(source, `${dir}/index.ts`).not.toMatch(/core\/index(\.ts)?["']/);
    }
  });
});
