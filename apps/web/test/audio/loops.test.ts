import { afterEach, describe, expect, it, vi } from "vitest";

// The ambient loop loader (src/audio/loops.ts). Each loop is its own lazy asset, found by the
// glob key `./ambient-<themeId>.wav`; a key that drifts from the file names would silently leave
// a theme without sound. fetch is stubbed, so only the loader's own wiring is under test.

const THEMES = ["cyberpunk", "steampunk", "solarpunk", "aero"];

function stubFetch(ok = true) {
  const urls: string[] = [];
  const fetchStub = vi.fn(async (url: string) => {
    urls.push(String(url));
    return {
      ok,
      status: ok ? 200 : 404,
      arrayBuffer: async () => new ArrayBuffer(16),
    };
  });
  vi.stubGlobal("fetch", fetchStub);
  return { fetchStub, urls };
}

async function freshLoader() {
  vi.resetModules();
  return import("../../src/audio/loops.ts");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadAmbientLoop", () => {
  it("resolves with the encoded loop for each of the four themes", async () => {
    const { urls } = stubFetch();
    const { loadAmbientLoop } = await freshLoader();
    for (const theme of THEMES) {
      const asset = await loadAmbientLoop(theme);
      expect(asset, theme).toBeInstanceOf(ArrayBuffer);
    }
    // One request per theme, each for that theme's own file.
    expect(urls).toHaveLength(THEMES.length);
    THEMES.forEach((theme, i) => {
      expect(urls[i], theme).toContain(`ambient-${theme}`);
    });
  });

  it("rejects for a theme with no loop file, without fetching", async () => {
    const { fetchStub } = stubFetch();
    const { loadAmbientLoop } = await freshLoader();
    await expect(loadAmbientLoop("vaporwave")).rejects.toThrow(/vaporwave/);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("fetches a theme once and shares the result", async () => {
    const { fetchStub } = stubFetch();
    const { loadAmbientLoop } = await freshLoader();
    const first = await loadAmbientLoop("aero");
    const second = await loadAmbientLoop("aero");
    expect(second).toBe(first);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("rejects on a failed response and tries again on the next request", async () => {
    const { fetchStub } = stubFetch(false);
    const { loadAmbientLoop } = await freshLoader();
    await expect(loadAmbientLoop("aero")).rejects.toThrow(/404/);
    await expect(loadAmbientLoop("aero")).rejects.toThrow(/404/);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});
