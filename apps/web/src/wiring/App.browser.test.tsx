import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { App } from "../App.tsx";

const wiring = vi.hoisted(() => {
  const stop = vi.fn();
  return { stop, start: vi.fn(() => stop) };
});

// Only the mount is under test: stub the wiring and the parts that need an engine or WebGL.
vi.mock("./index.ts", () => ({ startWiring: wiring.start }));
vi.mock("../pairing/session.tsx", () => ({
  SessionProvider: ({ children }: { children: unknown }) => children,
  usePairing: () => ({ state: { status: "checking" }, retry: () => {} }),
  // HistoryProvider (mounted by App) reads the session through this hook.
  useSession: () => "test-session",
}));
vi.mock("../SceneRoot.tsx", () => ({ SceneRoot: () => null }));

describe("App", () => {
  it("starts the wiring once when it mounts, even before pairing, and stops it on unmount", async () => {
    const view = await render(<App />);
    expect(wiring.start).toHaveBeenCalledTimes(1);
    expect(wiring.stop).not.toHaveBeenCalled();

    await view.unmount();
    expect(wiring.stop).toHaveBeenCalledTimes(1);
  });
});
