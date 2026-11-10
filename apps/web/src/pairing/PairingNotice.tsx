import { Button } from "react-aria-components";
import styles from "./PairingNotice.module.css";
import type { PairingState } from "./pair.ts";

type Refused = Exclude<PairingState, { status: "paired" }>;

/** How to get a new link: p when this engine reads keys, otherwise a restart (M7.19). */
function Recovery({ keyListener }: { keyListener: boolean }) {
  return keyListener ? (
    <>To get a new link, press p in the terminal running taskville.</>
  ) : (
    <>
      To get a new link, stop taskville (Ctrl+C) in the terminal running it, then run{" "}
      <code>taskville start</code> again.
    </>
  );
}

const COPY = {
  unpaired: {
    title: "Not paired",
    body: (keyListener: boolean) => (
      <>
        Open the one-time link that taskville prints or opens for you.{" "}
        <Recovery keyListener={keyListener} />
      </>
    ),
    retry: false,
  },
  invalid_code: {
    title: "Pairing link not accepted",
    body: (keyListener: boolean) => (
      <>
        The link is invalid, already used, or expired. <Recovery keyListener={keyListener} />
      </>
    ),
    retry: false,
  },
  network: {
    title: "Cannot reach the engine",
    body: (keyListener: boolean) => (
      <>
        Check that taskville is running, then try again. <Recovery keyListener={keyListener} />
      </>
    ),
    retry: true,
  },
  pairing_network: {
    title: "Could not finish pairing",
    body: (keyListener: boolean) => (
      <>
        The engine did not answer. Open the pairing link again; a link that was already used will
        not work. <Recovery keyListener={keyListener} />
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
