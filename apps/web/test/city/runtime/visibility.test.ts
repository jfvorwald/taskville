import { describe, expect, it } from "vitest";
import { watchVisibility } from "../../../src/city/runtime/visibility.ts";

// M3.14, ARCHITECTURE.md section 2.8: "If the browser tab is hidden, animation pauses and the
// presentation is rebuilt on return." `watchVisibility` is the seam: it turns `visibilitychange`
// into a pause and a resume, with a fake document so it runs in node.

function fakeDocument(initial: "visible" | "hidden" = "visible") {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: initial as string,
    addEventListener(type: string, listener: () => void) {
      if (type === "visibilitychange") listeners.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === "visibilitychange") listeners.delete(listener);
    },
  };
  return {
    doc,
    listenerCount: () => listeners.size,
    set(state: "visible" | "hidden") {
      doc.visibilityState = state;
      for (const l of [...listeners]) l();
    },
  };
}

function setup(initial: "visible" | "hidden" = "visible") {
  const d = fakeDocument(initial);
  let t = 1000;
  const calls: string[] = [];
  const resumes: { hiddenForMs: number }[] = [];
  const stop = watchVisibility(d.doc, {
    now: () => t,
    onPause: () => calls.push("pause"),
    onResume: (info) => {
      calls.push("resume");
      resumes.push(info);
    },
  });
  return {
    d,
    calls,
    resumes,
    stop,
    at(ms: number) {
      t = ms;
    },
  };
}

describe("hidden-tab pause and resume", () => {
  it("does nothing while the tab stays visible", () => {
    const { calls } = setup();
    expect(calls).toEqual([]);
  });

  it("pauses when the tab becomes hidden, and resumes (rebuild) when it returns", () => {
    const { d, calls, resumes, at } = setup();
    at(2000);
    d.set("hidden");
    expect(calls).toEqual(["pause"]);
    at(32_000);
    d.set("visible");
    expect(calls).toEqual(["pause", "resume"]);
    expect(resumes).toEqual([{ hiddenForMs: 30_000 }]);
  });

  it("pauses at once when it starts out hidden", () => {
    const { calls } = setup("hidden");
    expect(calls).toEqual(["pause"]);
  });

  it("ignores repeated events for the state it is already in", () => {
    const { d, calls } = setup();
    d.set("hidden");
    d.set("hidden");
    d.set("visible");
    d.set("visible");
    expect(calls).toEqual(["pause", "resume"]);
  });

  it("can pause and resume more than once", () => {
    const { d, calls, resumes, at } = setup();
    at(1000);
    d.set("hidden");
    at(1500);
    d.set("visible");
    at(2000);
    d.set("hidden");
    at(5000);
    d.set("visible");
    expect(calls).toEqual(["pause", "resume", "pause", "resume"]);
    expect(resumes.map((r) => r.hiddenForMs)).toEqual([500, 3000]);
  });

  it("stops listening when disposed", () => {
    const { d, calls, stop } = setup();
    expect(d.listenerCount()).toBe(1);
    stop();
    expect(d.listenerCount()).toBe(0);
    d.set("hidden");
    expect(calls).toEqual([]);
  });
});
