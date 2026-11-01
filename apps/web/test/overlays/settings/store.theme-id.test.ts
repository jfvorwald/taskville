import { describe, expect, it } from "vitest";
import { createSettingsStore, DEFAULT_SETTINGS } from "../../../src/overlays/settings/store.ts";
import { KEY, memoryStorage } from "./support.ts";

// Finding 4 (security S1): a stored theme id must match /^[a-z0-9][a-z0-9_-]{0,63}$/,
// otherwise the default. The id is later used by the theme system, so hostile text is refused.

const HOSTILE = ["x".repeat(10000), "a;b{c}", "url(x)", "Cyberpunk", "a".repeat(65), "-lead", " a"];
const ACCEPTED = ["cyberpunk", "neo-tokyo_2", "a", "0", `a${"b".repeat(63)}`];

describe("settings store, theme id", () => {
  it.each(HOSTILE)("falls back to the default for a stored theme id of %j", (id) => {
    const storage = memoryStorage({ [KEY("theme")]: JSON.stringify(id) });
    expect(createSettingsStore(storage).getSnapshot().theme).toBe(DEFAULT_SETTINGS.theme);
  });

  it.each(HOSTILE)("refuses to set a theme id of %j", (id) => {
    const storage = memoryStorage();
    const store = createSettingsStore(storage);
    store.set("theme", "neo");
    store.set("theme", id);
    expect(store.getSnapshot().theme).toBe("neo");
    expect(storage.data.get(KEY("theme"))).toBe('"neo"');
  });

  // Regression guard: passes today and must keep passing.
  it.each(ACCEPTED)("accepts the theme id %j", (id) => {
    const storage = memoryStorage({ [KEY("theme")]: JSON.stringify(id) });
    expect(createSettingsStore(storage).getSnapshot().theme).toBe(id);
  });
});
