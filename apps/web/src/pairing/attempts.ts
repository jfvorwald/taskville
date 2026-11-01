import type { PairingState } from "./pair.ts";

/**
 * Keeps one pairing attempt current. A new attempt (a retry, or a fresh link pasted into the
 * tab) supersedes the one before it, whose late result must not replace the newer state.
 */
export class Attempts {
  #current: Promise<PairingState> | undefined;

  /** The running attempt, or a new one. React StrictMode mounts effects twice in development. */
  current(run: () => Promise<PairingState>): Promise<PairingState> {
    return this.#current ?? this.start(run);
  }

  /** Starts an attempt that supersedes every earlier one. */
  start(run: () => Promise<PairingState>): Promise<PairingState> {
    const attempt = run();
    this.#current = attempt;
    return attempt;
  }

  /** Passes `attempt`'s result on only if no newer attempt has started since. */
  deliver(attempt: Promise<PairingState>, onResult: (state: PairingState) => void): void {
    void attempt.then((state) => {
      if (this.#current === attempt) onResult(state);
    });
  }
}
