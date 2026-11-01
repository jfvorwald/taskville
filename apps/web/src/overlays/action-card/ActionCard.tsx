import {
  Fragment,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { formatWaiting, stripControls, visibleControls } from "./format.ts";
import { inputText } from "./input.ts";
import { inputMaskSpans, type MaskSpan, markControls } from "./mask.ts";
import { type CardTarget, useCardTarget } from "./target.ts";

export const ACTION_CARD_ID = "action-card";

/** How often the waiting time is recomputed from the store clock. */
const TICK_MS = 1000;

/** How long Allow stays off after an exact input renders, so a click made as it appears is not taken. */
const SETTLE_MS = 500;

/** How long an engine call may take before the card stops waiting for it. */
const INPUT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 10_000;

/** The engine's limit for a deny note (MAX_DENY_MESSAGE_CHARS). */
const NOTE_MAX_CHARS = 1000;

export type ActionCardProps = OverlayProps & {
  /** The data store to read. Default: the app store. */
  store?: DataStore;
  /** The fetch used for engine calls. Default: the global fetch. */
  fetch?: Fetch;
  /**
   * The request the recording shows, consulted only in history mode: `undefined` keeps the live
   * path, `null` shows no card, a target shows that request read-only.
   */
  recordedTarget?: CardTarget | null | undefined;
  /**
   * The live target when the caller keeps it (so it survives a recording being shown). Default:
   * the card reads and keeps its own from `store`.
   */
  liveTarget?: CardTarget | null | undefined;
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

/** A key for one click. A retry of the same click reuses it, so the engine can tell it is a replay. */
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

const NOT_HELD_TEXT = "The hold ended. Answer in the terminal, or open the session.";

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
        <span key={span.start} className={styles.revealed} data-revealed={index} tabIndex={-1}>
          {text.slice(span.start, span.end)}
        </span>
      ) : (
        <button
          key={span.start}
          type="button"
          className={styles.reveal}
          data-mask={index}
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

/** A scroll area must be reachable by keyboard, or its overflow cannot be read without a mouse. */
const FOCUSABLE = { tabIndex: 0 };

/** The exact input in a monospace scroll area; focusable so a keyboard can scroll it. */
function InputBox({
  boxRef,
  onScroll,
  children,
}: {
  boxRef: RefObject<HTMLPreElement | null>;
  onScroll?: () => void;
  children: ReactNode;
}) {
  return (
    <pre
      ref={boxRef}
      className={styles.input}
      data-testid="action-card-input"
      {...FOCUSABLE}
      onScroll={onScroll}
    >
      {children}
    </pre>
  );
}

/**
 * The action card (ARCHITECTURE.md 2.4): for the selected agent that needs you, who is asking,
 * for what, the exact input, and Allow once, Deny or Open session. Every string from the agent or
 * the engine is a React text child, with invisible and reordering characters made visible.
 * Sending a decision ends as "Sent, unconfirmed": the engine has relayed it, only the agent's own
 * event confirms it.
 */
export function ActionCard({
  mode,
  selection,
  store = dataStore,
  fetch = defaultFetch,
  recordedTarget,
  liveTarget,
}: ActionCardProps) {
  const secret = useSession();
  // A recorded card never feeds the live kept target, and a live one never shows in its place.
  const recorded = mode === "history" && recordedTarget !== undefined;
  const kept = liveTarget !== undefined;
  const own = useCardTarget(store, recorded || kept ? null : selection.selectedId);
  const target = recorded ? recordedTarget : kept ? liveTarget : own;
  if (target === null) return null;
  return (
    <CardBody
      key={`${mode}:${storeId(store)}:${target.agentId}:${target.requestId}`}
      target={target}
      mode={mode}
      store={store}
      fetch={fetch}
      secret={secret}
    />
  );
}

let nextStoreId = 0;
const storeIds = new WeakMap<DataStore, number>();

/** A store's identity as a key part, so a card read from another store starts afresh. */
function storeId(store: DataStore): number {
  let id = storeIds.get(store);
  if (id === undefined) {
    id = nextStoreId;
    nextStoreId += 1;
    storeIds.set(store, id);
  }
  return id;
}

/** What a live card has done for one request: it outlives the card when a recording replaces it. */
interface LiveDraft {
  sent: boolean;
  note: string;
  retry: { signature: string; key: string } | null;
}

const drafts = new WeakMap<DataStore, Map<string, LiveDraft>>();

function liveDraft(store: DataStore, projectId: string | null, requestId: string): LiveDraft {
  let byRequest = drafts.get(store);
  if (byRequest === undefined) {
    byRequest = new Map();
    drafts.set(store, byRequest);
  }
  // A reset of the store (another project, a fresh sync) starts every request over.
  const key = `${store.getState().resetGeneration}:${projectId ?? ""}:${requestId}`;
  let draft = byRequest.get(key);
  if (draft === undefined) {
    draft = { sent: false, note: "", retry: null };
    byRequest.set(key, draft);
  }
  return draft;
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
  const sessionCwd = useData(
    (s) =>
      target.sessionId === undefined
        ? undefined
        : s.state?.sessions?.[target.sessionId]?.workingDirectory,
    store,
  );
  const { requestId } = target;
  const wantsInput = !readOnly && target.answerable && projectId !== null;

  const [load, setLoad] = useState<Load>({ kind: wantsInput ? "loading" : "idle" });
  // A recorded card never reads or writes this: only the live card has sent anything.
  const draft = useMemo(
    () => (readOnly ? null : liveDraft(store, projectId, requestId)),
    [readOnly, store, projectId, requestId],
  );
  const [sent, setSent] = useState(draft?.sent ?? false);
  const [forced, setForced] = useState<"closed" | null>(null);
  const [notHeld, setNotHeld] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [note, setNote] = useState(draft?.note ?? "");
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set());
  const [settled, setSettled] = useState(false);
  const [scroll, setScroll] = useState({ overflow: false, atEnd: true });
  const [now, setNow] = useState(() => store.now());
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const commandTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retry = useRef<{ signature: string; key: string } | null>(draft?.retry ?? null);
  const boxRef = useRef<HTMLPreElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const focusAfterReveal = useRef<number | null>(null);
  const noteId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(commandTimer.current);
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(store.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [store]);

  // Clear the previous input and approval state before a replacement can be painted.
  useLayoutEffect(() => {
    setLoad({ kind: wantsInput ? "loading" : "idle" });
    setRevealed(new Set());
    setSettled(false);
    focusAfterReveal.current = null;
    if (!wantsInput) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INPUT_TIMEOUT_MS);
    void fetchExactInput({ fetch, secret, projectId, requestId, signal: controller.signal }).then(
      (result) => {
        clearTimeout(timer);
        if (cancelled) return;
        if (result.kind === "ok") setLoad({ kind: "ok", input: result.input });
        else setLoad({ kind: result.kind === "expired" ? "expired" : "failed" });
      },
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [wantsInput, fetch, secret, projectId, requestId]);

  // Allow stays off for a moment after the input appears.
  useEffect(() => {
    if (load.kind !== "ok") return;
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [load]);

  const recorded = recordedState(target.requestState);
  let state: CardState = sent ? "sent" : (forced ?? recorded);
  // A card that only remembers its request offers no decision on it.
  if (state === "open" && target.stale === true) state = "closed";
  // The bridge no longer holding the request only matters while the request is still open: a
  // state the store recorded outranks it.
  const variant =
    target.answerable && !((notHeld || load.kind === "expired") && state === "open")
      ? "decision"
      : "open-only";

  const shown = useMemo(() => {
    if (load.kind !== "ok") return null;
    const raw = inputText(load.input.toolInput);
    return markControls(raw, inputMaskSpans(load.input.toolInput, raw));
  }, [load]);
  const text = shown?.text ?? null;
  const spans = shown?.spans ?? [];
  const unrevealed = spans.filter((_, index) => !revealed.has(index)).length;
  const lineCount = text === null ? 0 : text.split("\n").length;

  // Does the input box overflow, and has it been scrolled to the end?
  const measure = useCallback(() => {
    const box = boxRef.current;
    if (box === null) return;
    const overflow = box.scrollHeight > box.clientHeight + 1;
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
    setScroll((before) =>
      before.overflow === overflow && before.atEnd === atEnd ? before : { overflow, atEnd },
    );
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the box changes size when its text or reveals change
  useLayoutEffect(measure, [measure, text, revealed]);
  const hasBox = text !== null;
  useEffect(() => {
    const box = boxRef.current;
    if (!hasBox || box === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [hasBox, measure]);

  // After a reveal the clicked button is gone: move focus on, to the next reveal or the text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each reveal
  useLayoutEffect(() => {
    const index = focusAfterReveal.current;
    const box = boxRef.current;
    focusAfterReveal.current = null;
    if (index === null || box === null) return;
    const buttons = Array.from(box.querySelectorAll<HTMLElement>("button[data-mask]"));
    const next = buttons.find((b) => Number(b.dataset.mask) > index) ?? buttons[0];
    (next ?? box.querySelector<HTMLElement>(`[data-revealed="${index}"]`))?.focus();
  }, [revealed]);

  // After a send the status line takes focus, so a screen reader reads the result.
  useEffect(() => {
    if (state === "sent") statusRef.current?.focus();
  }, [state]);

  const cwd = (load.kind === "ok" ? load.input.cwd : undefined) ?? sessionCwd;

  const locked = state !== "open" || busy;
  const canOpen = !locked && target.sessionId !== undefined;
  const canAllow =
    !locked &&
    load.kind === "ok" &&
    unrevealed === 0 &&
    settled &&
    (!scroll.overflow || scroll.atEnd);

  const fail = (code: string) => {
    if (code === "request_expired") setNotHeld(true);
    else if (code === "request_not_open") setForced("closed");
    else {
      if (code === "not_answerable") setNotHeld(true);
      setNotice({ kind: "error", text: commandErrorMessage(code) });
    }
  };

  const submit = async (
    make: (idempotencyKey: string) => CommandBody,
    done: (command: CommandRecord) => Promise<void> | void,
  ) => {
    if (inFlight.current || state !== "open") return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    // A retry of the same command after a lost answer reuses its key; anything else gets a new one.
    const signature = JSON.stringify(make(""));
    const key = retry.current?.signature === signature ? retry.current.key : newKey();
    const controller = new AbortController();
    let timedOut = false;
    commandTimer.current = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, COMMAND_TIMEOUT_MS);
    const result = await sendCommand({ fetch, secret, body: make(key), signal: controller.signal });
    clearTimeout(commandTimer.current);
    inFlight.current = false;
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      retry.current = null;
      if (draft) draft.retry = null;
      await done(result.command);
      return;
    }
    const code = timedOut ? "timeout" : result.code;
    // The first command may still be running (or have run), so its retry must stay a replay.
    const unreadableSuccess = code === "unknown" && result.status >= 200 && result.status < 300;
    const unresolved =
      code === "network" || code === "timeout" || code === "command_in_flight" || unreadableSuccess;
    retry.current = unresolved ? { signature, key } : null;
    if (draft) draft.retry = retry.current;
    fail(code);
  };

  const decide = (behavior: "allow" | "deny") => {
    if (projectId === null) return;
    void submit(
      (idempotencyKey) => buildDecideBody({ projectId, requestId, idempotencyKey, behavior, note }),
      ({ status }) => {
        if (status === "delivered") {
          if (draft) draft.sent = true;
          setSent(true);
        } else setNotice({ kind: "error", text: commandErrorMessage("unknown") });
      },
    );
  };

  const open = () => {
    const { sessionId } = target;
    if (projectId === null || sessionId === undefined) return;
    void submit(
      (idempotencyKey) => buildOpenBody({ projectId, requestId, sessionId, idempotencyKey }),
      async ({ result }) => {
        if (result?.outcome === "opened") {
          setNotice({ kind: "info", text: "Session opened." });
        } else if (result?.outcome === "copy-only") {
          const id = result.sessionId ?? sessionId;
          const where = result.cwd ?? cwd;
          const lines = [`session ${stripControls(id)}`];
          if (where !== undefined) lines.push(`cwd ${stripControls(where)}`);
          try {
            await navigator.clipboard.writeText(lines.join("\n"));
            if (mounted.current) {
              setNotice({ kind: "info", text: "Copied the session id and working directory." });
            }
          } catch {
            const detail = where === undefined ? id : `${id} in ${where}`;
            if (mounted.current) {
              setNotice({
                kind: "info",
                text: `Could not copy. Session ${visibleControls(detail)}`,
              });
            }
          }
        } else {
          setNotice({ kind: "info", text: "Session open requested." });
        }
      },
    );
  };

  const reveal = (index: number) => {
    focusAfterReveal.current = index;
    setRevealed((before) => new Set(before).add(index));
  };

  const statusText =
    state !== "open" ? STATUS_TEXT[state] : notice?.kind === "info" ? notice.text : "";

  return (
    <InteractiveRegion
      className={styles.card}
      data-testid="action-card"
      data-state={state}
      data-variant={variant}
      data-readonly={readOnly ? "true" : undefined}
    >
      <h2 className={styles.title}>{visibleControls(target.agentName)}</h2>
      {target.heuristic === true && (
        <p className={styles.hint}>
          Possibly needs you: the source guessed which agent this request belongs to.
        </p>
      )}
      <dl className={styles.facts}>
        <dt>Project</dt>
        <dd>{projectId === null ? null : visibleControls(projectId)}</dd>
        {target.sessionId !== undefined && (
          <>
            <dt>Session</dt>
            <dd>{visibleControls(target.sessionId)}</dd>
          </>
        )}
        {target.toolName !== undefined && (
          <>
            <dt>Tool</dt>
            <dd>{visibleControls(target.toolName)}</dd>
          </>
        )}
        <dt>Waiting</dt>
        <dd>{formatWaiting(now - target.sinceMs)}</dd>
      </dl>
      {!readOnly && load.kind !== "loading" && (
        <p className={styles.cwd} data-testid="action-card-cwd">
          {`Working directory: ${cwd === undefined ? "unknown" : visibleControls(cwd)}`}
        </p>
      )}

      <p ref={statusRef} className={styles.status} role="status" tabIndex={-1}>
        {statusText}
      </p>

      {readOnly ? (
        <>
          <p className={styles.hint}>Recorded preview</p>
          <InputBox boxRef={boxRef}>
            {visibleControls(target.inputPreview ?? "No input recorded.")}
          </InputBox>
        </>
      ) : variant === "open-only" ? (
        <p className={styles.reason}>
          {state === "open" && (notHeld || load.kind === "expired")
            ? NOT_HELD_TEXT
            : visibleControls(
                target.reason ?? "This prompt is not held by Taskville. Answer it in the terminal.",
              )}
        </p>
      ) : (
        <>
          {text !== null && (
            <InputBox boxRef={boxRef} onScroll={measure}>
              {inputNodes(text, spans, revealed, reveal)}
            </InputBox>
          )}
          {scroll.overflow && text !== null && (
            <p className={styles.hint}>
              {`Input: ${lineCount} lines. Scroll to the end to enable Allow once.`}
            </p>
          )}
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
            maxLength={NOTE_MAX_CHARS}
            value={note}
            disabled={locked}
            onChange={(event) => {
              if (draft) draft.note = event.target.value;
              setNote(event.target.value);
            }}
          />
        </>
      )}

      {notice?.kind === "error" && (
        <p className={styles.error} role="alert">
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
