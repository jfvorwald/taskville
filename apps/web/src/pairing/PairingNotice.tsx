import { Button } from "react-aria-components";
import styles from "./PairingNotice.module.css";
import type { PairingState } from "./pair.ts";

type Refused = Exclude<PairingState, { status: "paired" }>;

const COPY = {
  unpaired: {
    title: "Not paired",
    body: (
      <>
        Run <code>taskville serve</code> and open the one-time link it prints. Press p in that
        terminal for a new one.
      </>
    ),
    retry: false,
  },
  invalid_code: {
    title: "Pairing link not accepted",
    body: (
      <>
        The link is invalid, already used, or expired. Press p in the <code>taskville serve</code>{" "}
        terminal for a new one.
      </>
    ),
    retry: false,
  },
  network: {
    title: "Cannot reach the engine",
    body: (
      <>
        Check that <code>taskville serve</code> is running, then try again.
      </>
    ),
    retry: true,
  },
  pairing_network: {
    title: "Could not finish pairing",
    body: (
      <>
        The engine did not answer. Open the pairing link again; if it was already used, press p in
        the <code>taskville serve</code> terminal for a new one.
      </>
    ),
    retry: false,
  },
  storage: {
    title: "This browser would not keep the pairing",
    body: "Site storage is blocked for this page. Allow it, then open a fresh pairing link.",
    retry: false,
  },
} as const;

/** Shown instead of the city whenever the page holds no usable session. It asks for no data. */
export function PairingNotice({ state, onRetry }: { state: Refused; onRetry: () => void }) {
  const copy = COPY[state.status === "failed" ? state.reason : "unpaired"];
  return (
    <main className={styles.page} data-testid="pairing-notice">
      <section className={styles.card}>
        <h1 className={styles.title}>{copy.title}</h1>
        <p className={styles.body}>{copy.body}</p>
        {copy.retry && (
          <Button className={styles.button} onPress={onRetry}>
            Try again
          </Button>
        )}
      </section>
    </main>
  );
}
