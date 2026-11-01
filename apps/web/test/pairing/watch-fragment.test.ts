import { describe, expect, it, vi } from "vitest";
import { watchPairingFragment } from "../../src/pairing/browser-env.ts";

function target(hash: string) {
  const events = new EventTarget();
  return Object.assign(events, { location: { hash } });
}

describe("watchPairingFragment", () => {
  it("calls back when a fresh pairing fragment arrives in the same tab", () => {
    const win = target("");
    const onFresh = vi.fn();
    watchPairingFragment(win, onFresh);
    win.location.hash = "#pair=abc";
    win.dispatchEvent(new Event("hashchange"));
    expect(onFresh).toHaveBeenCalledOnce();
  });

  it("ignores fragment changes that carry no pairing code, such as the clearing itself", () => {
    const win = target("#pair=abc");
    const onFresh = vi.fn();
    watchPairingFragment(win, onFresh);
    win.location.hash = "";
    win.dispatchEvent(new Event("hashchange"));
    win.location.hash = "#other=1";
    win.dispatchEvent(new Event("hashchange"));
    expect(onFresh).not.toHaveBeenCalled();
  });

  it("stops listening when the returned function is called", () => {
    const win = target("");
    const onFresh = vi.fn();
    const stop = watchPairingFragment(win, onFresh);
    stop();
    win.location.hash = "#pair=abc";
    win.dispatchEvent(new Event("hashchange"));
    expect(onFresh).not.toHaveBeenCalled();
  });
});
