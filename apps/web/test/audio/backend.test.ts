import { describe, expect, it, vi } from "vitest";
import { createWebAudioBackend } from "../../src/audio/backend.ts";

// The real Web Audio backend is built lazily: constructing it, or importing the module, must not
// create an AudioContext. Browsers block audio until a gesture (ARCHITECTURE 2.7: turned on with a
// click), and an early context starts suspended and warns.

/** A stand-in AudioContext that accepts any call and returns more stand-ins. */
function permissive(): unknown {
  const handler: ProxyHandler<() => unknown> = {
    get: (_target, prop) => (prop === "then" ? undefined : permissive()),
    apply: () => permissive(),
    set: () => true,
  };
  return new Proxy(() => undefined, handler);
}

describe("web audio backend", () => {
  it("does not create an AudioContext until start() is called", async () => {
    const createContext = vi.fn(() => permissive());
    const backend = createWebAudioBackend({ createContext: createContext as never });
    expect(createContext).not.toHaveBeenCalled();

    // Controls before start are harmless no-ops, not a reason to build a context.
    backend.setVolume(0.5);
    backend.stopLoop();
    expect(createContext).not.toHaveBeenCalled();

    await backend.start();
    expect(createContext).toHaveBeenCalledTimes(1);
    await backend.start();
    expect(createContext).toHaveBeenCalledTimes(1);
  });

  it("ignores a cue before start()", () => {
    const createContext = vi.fn(() => permissive());
    const backend = createWebAudioBackend({ createContext: createContext as never });
    backend.playCue("chime");
    expect(createContext).not.toHaveBeenCalled();
  });
});
