import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { getSettingsStore } from "../overlays/settings/index.ts";
import { CityRoot } from "../city/index.tsx";

// M3.22: the settings panel's reduced-motion choice, resolved against the OS preference, must
// reach every motion consumer CityRoot mounts. The children are stubbed to record the
// `reducedMotion` prop they receive; each real child falls back to the OS preference alone when
// the prop is undefined, which is the bug this pins down.
const seen = vi.hoisted(() => ({
  celebrations: [] as unknown[],
  interaction: [] as unknown[],
  agents: [] as unknown[],
}));

vi.mock("../city/effects/index.ts", () => ({
  Celebrations: (props: { reducedMotion?: boolean }) => {
    seen.celebrations.push(props.reducedMotion);
    return null;
  },
}));
vi.mock("../city/interaction/index.ts", () => ({
  InteractionLayer: (props: { reducedMotion?: boolean }) => {
    seen.interaction.push(props.reducedMotion);
    return null;
  },
}));
vi.mock("../city/movement/index.ts", () => ({
  CityAgents: (props: { reducedMotion?: boolean }) => {
    seen.agents.push(props.reducedMotion);
    return null;
  },
}));
vi.mock("../city/lighting/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../city/lighting/index.ts")>()),
  DayNightLighting: () => null,
}));
vi.mock("../themes/core/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../themes/core/index.ts")>()),
  ThemedCity: () => null,
}));

/** The OS `prefers-reduced-motion` stand-in. `useReducedMotion` reads `matchMedia` on first use. */
const os = { matches: false };

beforeAll(() => {
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return os.matches;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  getSettingsStore().set("reducedMotion", "system");
  os.matches = false;
  seen.celebrations.length = 0;
  seen.interaction.length = 0;
  seen.agents.length = 0;
});

describe("CityRoot reduced motion", () => {
  it('setting "on" while the OS allows motion: celebrations and the building fade are reduced', async () => {
    os.matches = false;
    getSettingsStore().set("reducedMotion", "on");

    await render(<CityRoot />);

    expect(seen.agents.at(-1)).toBe(true);
    expect(seen.celebrations.at(-1)).toBe(true);
    expect(seen.interaction.at(-1)).toBe(true);
  });

  it('setting "off" while the OS asks for reduced motion: both animate', async () => {
    os.matches = true;
    getSettingsStore().set("reducedMotion", "off");

    await render(<CityRoot />);

    expect(seen.agents.at(-1)).toBe(false);
    expect(seen.celebrations.at(-1)).toBe(false);
    expect(seen.interaction.at(-1)).toBe(false);
  });
});
