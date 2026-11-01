import { Fragment, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useData } from "../../data/react.ts";
import { type DataStore, dataStore } from "../../data/store.ts";
import { useSession } from "../../pairing/session.tsx";
import { InteractiveRegion } from "../host/InteractiveRegion.tsx";
import type { OverlayDefinition, OverlayMode, OverlayProps } from "../host/types.ts";
import styles from "./action-card.module.css";
import {
  buildDecideBody,
  buildOpenBody,
  type CommandBody,
  type CommandRecord,
  commandErrorMessage,
  fetchExactInput,
  type HeldRequest,
  sendCommand,
} from "./api.ts";
import { formatWaiting } from "./format.ts";
import { inputText } from "./input.ts";
import { type MaskSpan, maskSpans } from "./mask.ts";
import { type CardTarget, useCardTarget } from "./target.ts";

export const ACTION_CARD_ID = "action-card";

/** How often the waiting time is recomputed from the store clock. */
const TICK_MS = 1000;

export type ActionCardProps = OverlayProps & {
  /** The data store to read. Default: the app store. */
  store?: DataStore;
  /** The fetch used for engine calls. Default: the global fetch. */
  fetch?: Fetch;
};

type Fetch = typeof fetch;

const defaultFetch: Fetch = (input, init) => globalThis.fetch(input, init);

type CardState = "open" | "sent" | "answered_elsewhere" | "expired" | "closed";

type Load =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; input: HeldRequest }
  | { kind: "failed" }
  | { kind: "expired" };

interface Notice {
  kind: "info" | "error";
  text: string;
}

/** A key for one click. Each click gets its own, so a retry is never mistaken for a replay. */
function newKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function recordedState(requestState: string): CardState {
  if (requestState === "open") return "open";
  if (requestState === "answered_elsewhere" || requestState === "expired") return requestState;
  return "closed";
}

const STATUS_TEXT: Record<Exclude<CardState, "open">, string> = {
  sent: "Sent, unconfirmed. Waiting for the agent to report back.",
  answered_elsewhere: "Answered in the terminal.",
  expired: "This request expired. The bridge no longer holds it; answer it in the terminal.",
  closed: "This request is no longer open.",
};

/** The input with each masked span replaced by a reveal button until it is revealed. */
function inputNodes(
  text: string,
  spans: readonly MaskSpan[],
  revealed: ReadonlySet<number>,
  reveal: (index: number) => void,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  spans.forEach((span, index) => {
    nodes.push(<Fragment key={`t${cursor}`}>{text.slice(cursor, span.start)}</Fragment>);
    nodes.push(
      revealed.has(index) ? (
        <span key={span.start} className={styles.revealed}>
          {text.slice(span.start, span.end)}
        </span>
      ) : (
        <button
          key={span.start}
          type="button"
          className={styles.reveal}
          onClick={() => reveal(index)}
        >
          {`Reveal masked ${span.kind}`}
        </button>
      ),
    );
    cursor = span.end;
  });
  nodes.push(<Fragment key={`t${cursor}`}>{text.slice(cursor)}</Fragment>);
  return nodes;
}

/** The exact input in a monospace scroll area; focusable so a keyboard can scroll it. */
function InputBox({ children }: { children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area must be reachable by keyboard
    <pre className={styles.input} data-testid="action-card-input" tabIndex={0}>
      {children}
    </pre>
  );
}

/**
 * The action card (ARCHITECTURE.md 2.4): for the selected agent that needs you, who is asking,
 * for what, the exact input, and Allow once, Deny or Open session. Every string from the agent or
 * the engine is a React text child. Sending a decision ends as "Sent, unconfirmed": the engine
 * has relayed it, only the agent's own event confirms it.
 */
export function ActionCard({
  mode,
  selection,
  store = dataStore,
  fetch = defaultFetch,
}: ActionCardProps) {
  const secret = useSession();
  const target = useCardTarget(store, selection.selectedId);
  if (target === null) return null;
  return (
    <CardBody
      key={`${target.agentId}:${target.requestId}`}
      target={target}
      mode={mode}
      store={store}
      fetch={fetch}
      secret={secret}
    />
  );
}

function CardBody({
  target,
  mode,
  store,
  fetch,
  secret,
}: {
  target: CardTarget;
  mode: OverlayMode;
  store: DataStore;
  fetch: Fetch;
  secret: string;
}) {
  const readOnly = mode === "history";
  const projectId = useData((s) => s.projectId, store);
  const { requestId } = target;
  const wantsInput = !readOnly && target.answerable && projectId !== null;

  const [load, setLoad] = useState<Load>({ kind: wantsInput ? "loading" : "idle" });
  const [sent, setSent] = useState(false);
  const [forced, setForced] = useState<"expired" | "closed" | null>(null);
  const [openOnly, setOpenOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [note, setNote] = useState("");
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set());
  const [now, setNow] = useState(() => store.now());
  const inFlight = useRef(false);
  const noteId = useId();

  useEffect(() => {
    const timer = setInterval(() => setNow(store.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [store]);

  useEffect(() => {
    if (!wantsInput) return;
    let cancelled = false;
    void fetchExactInput({ fetch, secret, projectId, requestId }).then((result) => {
      if (cancelled) return;
      if (result.kind === "ok") setLoad({ kind: "ok", input: result.input });
      else setLoad({ kind: result.kind === "expired" ? "expired" : "failed" });
    });
    return () => {
      cancelled = true;
    };
  }, [wantsInput, fetch, secret, projectId, requestId]);

  const state: CardState = sent
    ? "sent"
    : (forced ?? (load.kind === "expired" ? "expired" : recordedState(target.requestState)));
  const variant = target.answerable && !openOnly ? "decision" : "open-only";

  const text = load.kind === "ok" ? inputText(load.input.toolInput) : null;
  const spans = useMemo(() => (text === null ? [] : maskSpans(text)), [text]);
  const unrevealed = spans.length - revealed.size;
  const cwd = load.kind === "ok" ? load.input.cwd : undefined;

  const locked = state !== "open" || busy;
  const canOpen = !locked && target.sessionId !== undefined;
  const canAllow = !locked && load.kind === "ok" && unrevealed === 0;

  const fail = (code: string) => {
    if (code === "request_expired") setForced("expired");
    else if (code === "request_not_open") setForced("closed");
    else {
      if (code === "not_answerable") setOpenOnly(true);
      setNotice({ kind: "error", text: commandErrorMessage(code) });
    }
  };

  const submit = async (
    body: CommandBody,
    done: (command: CommandRecord) => Promise<void> | void,
  ) => {
    if (inFlight.current || state !== "open") return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    const result = await sendCommand({ fetch, secret, body });
    inFlight.current = false;
    setBusy(false);
    if (result.ok) await done(result.command);
    else fail(result.code);
  };

  const decide = (behavior: "allow" | "deny") => {
    if (projectId === null) return;
    void submit(
      buildDecideBody({ projectId, requestId, idempotencyKey: newKey(), behavior, note }),
      () => setSent(true),
    );
  };

  const open = () => {
    if (projectId === null || target.sessionId === undefined) return;
    void submit(
      buildOpenBody({
        projectId,
        requestId,
        sessionId: target.sessionId,
        idempotencyKey: newKey(),
      }),
      async ({ result }) => {
        if (result?.outcome === "opened") {
          setNotice({ kind: "info", text: "Session opened." });
        } else if (result?.outcome === "copy-only") {
          const sessionId = result.sessionId ?? target.sessionId ?? "";
          const where = result.cwd ?? cwd;
          try {
            await navigator.clipboard.writeText(
              where === undefined ? `session ${sessionId}` : `session ${sessionId}\ncwd ${where}`,
            );
            setNotice({ kind: "info", text: "Copied the session id and working directory." });
          } catch {
            const detail = where === undefined ? sessionId : `${sessionId} in ${where}`;
            setNotice({ kind: "info", text: `Could not copy. Session ${detail}` });
          }
        } else {
          setNotice({ kind: "info", text: "Session open requested." });
        }
      },
    );
  };

  const reveal = (index: number) => setRevealed((before) => new Set(before).add(index));

  return (
    <InteractiveRegion
      className={styles.card}
      data-testid="action-card"
      data-state={state}
      data-variant={variant}
      data-readonly={readOnly ? "true" : undefined}
    >
      <h2 className={styles.title}>{target.agentName}</h2>
      <dl className={styles.facts}>
        <dt>Project</dt>
        <dd>{projectId}</dd>
        {target.sessionId !== undefined && (
          <>
            <dt>Session</dt>
            <dd>{target.sessionId}</dd>
          </>
        )}
        {target.toolName !== undefined && (
          <>
            <dt>Tool</dt>
            <dd>{target.toolName}</dd>
          </>
        )}
        <dt>Waiting</dt>
        <dd>{formatWaiting(now - target.sinceMs)}</dd>
      </dl>
      {cwd !== undefined && (
        <p className={styles.cwd} data-testid="action-card-cwd">
          {cwd}
        </p>
      )}

      {state !== "open" && (
        <p className={styles.status} role="status">
          {STATUS_TEXT[state]}
        </p>
      )}

      {readOnly ? (
        <InputBox>{target.inputPreview ?? "No input recorded."}</InputBox>
      ) : variant === "open-only" ? (
        <p className={styles.reason}>
          {target.reason ?? "This prompt is not held by Taskville. Answer it in the terminal."}
        </p>
      ) : (
        <>
          {text !== null && <InputBox>{inputNodes(text, spans, revealed, reveal)}</InputBox>}
          {load.kind === "loading" && <p className={styles.hint}>Loading the exact input...</p>}
          {(load.kind === "failed" || load.kind === "idle") && state === "open" && (
            <p className={styles.hint}>
              Could not load the exact input, so Allow once is off. Deny and Open session still
              work.
            </p>
          )}
          {unrevealed > 0 && (
            <p className={styles.hint}>Reveal every masked value to read it before you allow.</p>
          )}
          <label className={styles.note} htmlFor={noteId}>
            Note for the agent (optional, sent with Deny)
          </label>
          <textarea
            id={noteId}
            className={styles.noteBox}
            rows={2}
            value={note}
            disabled={locked}
            onChange={(event) => setNote(event.target.value)}
          />
        </>
      )}

      {notice !== null && (
        <p
          className={notice.kind === "error" ? styles.error : styles.hint}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.text}
        </p>
      )}

      {!readOnly && (
        <div className={styles.actions}>
          {variant === "decision" && (
            <>
              <button
                type="button"
                className={styles.allow}
                disabled={!canAllow}
                onClick={() => decide("allow")}
              >
                Allow once
              </button>
              <button
                type="button"
                className={styles.deny}
                disabled={locked}
                onClick={() => decide("deny")}
              >
                Deny
              </button>
            </>
          )}
          <button type="button" className={styles.open} disabled={!canOpen} onClick={open}>
            Open session
          </button>
        </div>
      )}
    </InteractiveRegion>
  );
}

export const actionCardOverlay: OverlayDefinition = {
  id: ACTION_CARD_ID,
  slot: "sidebar",
  modes: ["live", "history"],
  Component: ActionCard,
};
