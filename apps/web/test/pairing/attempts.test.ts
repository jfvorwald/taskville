import { describe, expect, it } from "vitest";
import { Attempts } from "../../src/pairing/attempts.ts";
import type { PairingState } from "../../src/pairing/pair.ts";

const deferred = () => {
  let resolve: (state: PairingState) => void = () => {};
  const promise = new Promise<PairingState>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("Attempts", () => {
  it("reuses the running attempt, so StrictMode's second mount does not pair twice", () => {
    const attempts = new Attempts();
    let runs = 0;
    const run = () => {
      runs++;
      return Promise.resolve<PairingState>({ status: "unpaired" });
    };
    const first = attempts.current(run);
    const second = attempts.current(run);
    expect(second).toBe(first);
    expect(runs).toBe(1);
  });

  it("delivers only the newest attempt's result", async () => {
    const attempts = new Attempts();
    const slow = deferred();
    const fast = deferred();
    const seen: string[] = [];
    const onResult = (state: PairingState) => seen.push(state.status);

    attempts.deliver(attempts.start(() => slow.promise), onResult);
    attempts.deliver(attempts.start(() => fast.promise), onResult);
    fast.resolve({ status: "paired", secret: "s" });
    await fast.promise;
    slow.resolve({ status: "unpaired" });
    await slow.promise;
    await Promise.resolve();
    expect(seen).toEqual(["paired"]);
  });
});
