import { Button } from "react-aria-components";
import styles from "./PairingNotice.module.css";
import type { PairingState } from "./pair.ts";

type Refused = Exclude<PairingState, { status: "paired" }>;

const COPY = {
  unpaired: {
    title: "Not paired",
    body: () => (
      <>
        Run <code>taskville start</code> and open the one-time link it prints or opens for you.
      </>
    ),
    retry: false,
  },
  invalid_code: {
    title: "Pairing link not accepted",
    body: (keyListener: boolean) => (
      <>
        The link is invalid, already used, or expired. Run <code>taskville start</code> for a new
        one{keyListener ? ", or press p in its terminal" : ""}.
      </>
    ),
    retry: false,
  },
  network: {
    title: "Cannot reach the engine",
    body: () => (
      <>
        Check that <code>taskville start</code> is running, then try again.
      </>
    ),
    retry: true,
  },
  pairing_network: {
    title: "Could not finish pairing",
    body: (keyListener: boolean) => (
      <>
        The engine did not answer. Open the pairing link again; if it was already used, run{" "}
        <code>taskville start</code> for a new one
        {keyListener ? ", or press p in its terminal" : ""}.
      </>
    ),
    retry: false,
  },
  storage: {
    title: "This browser would not keep the pairing",
    body: () => "Site storage is blocked for this page. Allow it, then open a fresh pairing link.",
    retry: false,
  },
} as const;

/** Shown instead of the city whenever the page holds no usable session. It asks for no data. */
export function PairingNotice({ state, onRetry }: { state: Refused; onRetry: () => void }) {
  const copy = COPY[state.status === "failed" ? state.reason : "unpaired"];
  const keyListener = state.status === "failed" && state.keyListener === true;
  return (
    <main className={styles.page} data-testid="pairing-notice">
      <section className={styles.card}>
        <h1 className={styles.title}>{copy.title}</h1>
        <p className={styles.body}>{copy.body(keyListener)}</p>
        {copy.retry && (
          <Button className={styles.button} onPress={onRetry}>
            Try again
          </Button>
        )}
      </section>
    </main>
  );
}
