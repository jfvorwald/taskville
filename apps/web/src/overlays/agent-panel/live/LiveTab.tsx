import {
  elementScroll,
  observeWindowOffset,
  observeWindowRect,
  useVirtualizer,
  type VirtualizerOptions,
  windowScroll,
} from "@tanstack/react-virtual";
import { diffWordsWithSpace } from "diff";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";
import { type JsonValue, redactJson } from "../../../../../../packages/adapters/src/redact/json.ts";
import { redactText } from "../../../../../../packages/adapters/src/redact/text.ts";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import type { Agent } from "../../../data/domain.ts";
import { useData } from "../../../data/react.ts";
import type { DataStore } from "../../../data/store.ts";
import { cardTarget } from "../../action-card/target.ts";
import styles from "./live.module.css";

export interface LiveTabProps {
  agentId: string;
  store: DataStore;
  select: (id: string | null) => void;
  calls: readonly ToolCallFrame[];
  evidence: Readonly<Record<string, EvidenceResponse>>;
  /** Evidence IDs the server answered 410 evidence_evicted for: the call happened, the body is gone. */
  evicted?: ReadonlySet<string>;
}
const safe = (text: string) => redactText(text).text;
// TanStack's window mode, for a feed with no scrolling ancestor. useVirtualizer types its scroll
// element as an Element, so the window functions are cast once here.
const pageScroll = {
  observeElementRect: observeWindowRect,
  observeElementOffset: observeWindowOffset,
  scrollToFn: windowScroll,
} as unknown as Pick<
  VirtualizerOptions<HTMLElement, HTMLDivElement>,
  "observeElementRect" | "observeElementOffset" | "scrollToFn"
>;
/** The page's own scroller: scrollTop and sizes live on it, scroll events and the view on window. */
const isPage = (node: HTMLElement) => node === node.ownerDocument.scrollingElement;
/** Follow means within this many px of the bottom after layout. A pause needs a real scroll up. */
const FOLLOW_THRESHOLD = 8;
const distanceFromBottom = (node: HTMLElement) =>
  node.scrollHeight - node.clientHeight - node.scrollTop;
const EVICTED = "details no longer stored";
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === "string" ? value : undefined);

function bodyValue(body: EvidenceResponse | undefined): unknown {
  if (!body) return undefined;
  // Server mask ranges refer to the serialized text. Replace before parsing or splitting a diff.
  let text = body.text;
  for (const mask of [...(body.masks ?? [])].sort((a, b) => b.start - a.start)) {
    if (
      Number.isInteger(mask.start) &&
      Number.isInteger(mask.end) &&
      mask.start >= 0 &&
      mask.end <= text.length &&
      mask.end >= mask.start
    )
      text = `${text.slice(0, mask.start)}[REDACTED]${text.slice(mask.end)}`;
  }
  try {
    return redactJson(JSON.parse(text) as JsonValue).value;
  } catch {
    return safe(text);
  }
}

function Path({ path }: { path: string }) {
  const shown = safe(path);
  return path.startsWith("/") &&
    shown === path &&
    !Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ? (
    <a href={`vscode://file${path.split("/").map(encodeURIComponent).join("/")}`}>{shown}</a>
  ) : (
    <span>{shown}</span>
  );
}

/** Resolve recorded identities only, never names or a guessed destination. */
function targetAgent(
  call: ToolCallFrame,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  agents: readonly Agent[],
) {
  if (call.toolName === "SendMessage") {
    const id =
      input.recipient_kind === "agent_id"
        ? (string(input.to) ?? string(input.recipient))
        : undefined;
    return agents.find((agent) => agent.id === id);
  }
  if (call.toolName !== "Agent") return undefined;
  const raw = string(output.agentId);
  if (!raw) return undefined;
  const parent = agents.find((agent) => agent.id === call.agentId);
  const matches = agents.filter(
    (agent) =>
      agent.parentAgentId === call.agentId &&
      agent.sourceId === parent?.sourceId &&
      (agent.id === raw ||
        agent.sourceAgentId === raw ||
        // Claude's documented subagent namespace is session identity followed by source agent ID.
        (parent?.sourceId === "claude-code" &&
          agent.id.startsWith(`${parent.id}:`) &&
          agent.id.slice(parent.id.length + 1) === raw)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Claim a spawn or a send only once the recorded phase says it succeeded and the recorded result
 * does not say otherwise (a delivered hook can still carry `success: false`).
 */
function action(
  tool: "Agent" | "SendMessage",
  phase: ToolCallFrame["phase"],
  output: Record<string, unknown>,
) {
  const [done, failed, pending] =
    tool === "Agent"
      ? ["Spawned", "Spawn failed for", "Spawning"]
      : ["Sent message to", "Message failed to", "Sending message to"];
  if (phase === "succeeded") return output.success === false ? failed : done;
  if (phase === "failed") return failed;
  return phase === "running"
    ? pending
    : `No result recorded for ${tool === "Agent" ? "spawn of" : "message to"}`;
}

function ToolCard({
  call,
  evidence,
  evicted,
  agents,
  select,
  expanded,
  toggleExpanded,
}: {
  call: ToolCallFrame;
  evidence: LiveTabProps["evidence"];
  evicted: ReadonlySet<string>;
  agents: readonly Agent[];
  select: LiveTabProps["select"];
  expanded: boolean;
  toggleExpanded: () => void;
}) {
  const inputBody = call.evidence.input ? evidence[call.evidence.input.id] : undefined;
  const outputBody = call.evidence.output ? evidence[call.evidence.output.id] : undefined;
  // A reference the hook never sent stays "not reported"; one that was stored then evicted does not.
  const gone = (ref: ToolCallFrame["evidence"]["input"]) =>
    ref !== null && (ref.status === "evicted" || evicted.has(ref.id));
  const missingInput = !inputBody && gone(call.evidence.input) ? EVICTED : "not reported";
  const missingOutput = !outputBody && gone(call.evidence.output) ? EVICTED : "not reported";
  const inputValue = bodyValue(inputBody);
  const outputValue = bodyValue(outputBody);
  const input = object(inputValue);
  const output = object(outputValue);
  const paths = [
    ...new Set([
      ...call.filePaths,
      ...[string(input.file_path), string(input.path)].filter((p): p is string => p !== undefined),
      ...(Array.isArray(output.filenames)
        ? output.filenames.filter((p): p is string => typeof p === "string")
        : []),
    ]),
  ];
  const target = targetAgent(call, input, output, agents);
  const old = string(input.old_string);
  const next = string(input.new_string);
  const stdout = string(output.stdout);
  const stderr = string(output.stderr);
  const fallback =
    outputValue === undefined
      ? missingOutput
      : typeof outputValue === "string"
        ? outputValue
        : JSON.stringify(outputValue, null, 2);
  const tool = typeof call.toolName === "string" ? call.toolName : "not reported";
  const fragment =
    tool === "Edit" && old !== undefined && next !== undefined
      ? diffWordsWithSpace(old, next, { timeout: 25, maxEditLength: 1000 })
      : undefined;
  return (
    <article className={styles.card}>
      <h3>
        {safe(tool)}: {safe(string(call.phase) ?? "unknown")}
      </h3>
      <p>
        Timing:{" "}
        {typeof call.durationMs === "number" && Number.isFinite(call.durationMs)
          ? `${call.durationMs} ms`
          : "not reported"}
      </p>
      <p>
        Path:{" "}
        {paths.length
          ? paths.map((path) => (
              <span key={path}>
                <Path path={path} />{" "}
              </span>
            ))
          : "not reported"}
      </p>
      {tool === "Edit" ? (
        <div>
          <p>Edit fragment</p>
          {old !== undefined && next !== undefined ? (
            fragment === undefined ? (
              <>
                <p>Original fragment</p>
                <pre>{old}</pre>
                <p>Replacement fragment</p>
                <pre>{next}</pre>
              </>
            ) : (
              fragment.map((part) =>
                part.added ? (
                  <ins key={JSON.stringify(part)}>{part.value}</ins>
                ) : part.removed ? (
                  <del key={JSON.stringify(part)}>{part.value}</del>
                ) : (
                  <span key={JSON.stringify(part)}>{part.value}</span>
                ),
              )
            )
          ) : (
            <p>Input: {missingInput}</p>
          )}
        </div>
      ) : tool === "Write" ? (
        <pre>
          {string(input.content) ?? (typeof inputValue === "string" ? inputValue : missingInput)}
        </pre>
      ) : tool === "Bash" ? (
        <>
          <p>{string(input.command) ?? missingInput}</p>
          <Button onPress={toggleExpanded} aria-expanded={expanded}>
            {expanded ? "Collapse output" : "Expand output"}
          </Button>
          <pre>
            {stdout === undefined
              ? fallback
              : expanded
                ? stdout
                : stdout.split("\n").slice(-10).join("\n")}
          </pre>
          {stderr ? <pre>{stderr}</pre> : null}
        </>
      ) : tool === "Read" || tool === "Grep" || tool === "Search" || tool === "Glob" ? (
        <>
          <p>
            {tool === "Read" ? "Read" : "Search"}:{" "}
            {string(input.pattern) ?? string(input.query) ?? missingInput}
          </p>
          <pre>{fallback}</pre>
        </>
      ) : tool === "Agent" || tool === "SendMessage" ? (
        <>
          <p>
            {action(tool, call.phase, output)}{" "}
            {target ? (
              <Button onPress={() => select(target.id)}>
                {safe(target.displayName ?? target.id)}
              </Button>
            ) : (
              "not reported"
            )}
          </p>
          <pre>{inputValue === undefined ? missingInput : JSON.stringify(inputValue, null, 2)}</pre>
        </>
      ) : (
        <pre>{inputValue === undefined ? missingInput : JSON.stringify(inputValue, null, 2)}</pre>
      )}
      {tool !== "Bash" &&
      tool !== "Read" &&
      tool !== "Grep" &&
      tool !== "Search" &&
      tool !== "Glob" ? (
        <p>Output: {outputValue === undefined ? missingOutput : "recorded"}</p>
      ) : null}
      {inputBody?.truncated || outputBody?.truncated ? <p>Recorded excerpt truncated</p> : null}
    </article>
  );
}

export function LiveTab(props: LiveTabProps) {
  const projectId = useData((s) => s.state?.projectId, props.store);
  return <LiveFeed key={JSON.stringify([projectId, props.agentId])} {...props} />;
}

const NONE: ReadonlySet<string> = new Set();

function LiveFeed({ agentId, store, select, calls, evidence, evicted = NONE }: LiveTabProps) {
  const feed = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  // The offset the virtualizer last wrote, so its measurement corrections are not read as a reader.
  const written = useRef<number | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const page = viewport && isPage(viewport) ? viewport.ownerDocument.defaultView : null;
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    ...(page ? pageScroll : {}),
    scrollToFn: (offset, options, instance) => {
      (page ? pageScroll.scrollToFn : elementScroll)(offset, options, instance);
      written.current = viewport?.scrollTop ?? null;
    },
    count: calls.length,
    getScrollElement: () => (page as unknown as HTMLElement | null) ?? viewport,
    getItemKey: (index) => calls[index].toolCallId,
    estimateSize: () => 240,
    overscan: 5,
    scrollMargin,
    useFlushSync: false,
  });
  // The shell and controlled consumers already own scrolling. Include content before the list
  // in the virtualizer's coordinates rather than creating a second nested viewport.
  useLayoutEffect(() => {
    let node = feed.current?.parentElement;
    while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY))
      node = node.parentElement;
    // Never render zero rows: with no scrolling ancestor, the page itself scrolls the feed.
    setViewport(node ?? (document.scrollingElement as HTMLElement | null));
  }, []);
  // The virtualizer and follow already hold the reading position. Browser scroll anchoring on
  // the same viewport would move it a second time when a row is added or measured.
  useLayoutEffect(() => {
    if (!viewport) return;
    const previous = viewport.style.overflowAnchor;
    viewport.style.overflowAnchor = "none";
    return () => {
      viewport.style.overflowAnchor = previous;
    };
  }, [viewport]);
  useLayoutEffect(() => {
    if (!viewport || !rows.current) return;
    const measure = () => {
      if (!rows.current) return;
      // The page scroller's client box is the window, whose top is 0.
      setScrollMargin(
        rows.current.getBoundingClientRect().top -
          (isPage(viewport) ? 0 : viewport.getBoundingClientRect().top + viewport.clientTop) +
          viewport.scrollTop,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    if (feed.current) observer.observe(feed.current);
    return () => observer.disconnect();
  }, [viewport]);
  const changeFollow = useCallback(
    (value: boolean) => {
      followingRef.current = value;
      if (value && viewport) {
        viewport.scrollTop = viewport.scrollHeight;
      }
      setFollowing(value);
    },
    [viewport],
  );
  useEffect(() => {
    if (!viewport) return;
    // Following is judged by the distance from the bottom, not by the direction of a change: a
    // measurement correction can move scrollTop up while the view is still at the bottom.
    const onScroll = () => {
      if (
        distanceFromBottom(viewport) > FOLLOW_THRESHOLD &&
        !(written.current !== null && Math.abs(viewport.scrollTop - written.current) <= 1)
      ) {
        followingRef.current = false;
        setFollowing(false);
      }
    };
    // The page scroller's scroll events are dispatched to its document, not to the element.
    const events = isPage(viewport) ? viewport.ownerDocument : viewport;
    events.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => events.removeEventListener("scroll", onScroll, true);
  }, [viewport]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.key.toLowerCase() !== "f" ||
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        (target instanceof HTMLElement &&
          (target.isContentEditable || target.closest("input, textarea, select, [role=dialog]"))) ||
        !feed.current?.getClientRects().length
      )
        return;
      event.preventDefault();
      changeFollow(!followingRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [changeFollow]);
  // Reconcile after each measured layout, including streaming output and expansion.
  useLayoutEffect(() => {
    if (!viewport) return;
    // TanStack measures rows mounted during a scroll only on the next ResizeObserver frame,
    // then corrects the estimate above the fold by writing scrollTop from its last reported
    // offset. That late write moves a paused reader, overwrites a newer scroll and looks like
    // an upward gesture. Measure new rows in this commit instead, before paint.
    for (const node of Array.from(rows.current?.children ?? [])) {
      const index = virtualizer.indexFromElement(node as HTMLDivElement);
      if (
        index >= 0 &&
        index < calls.length &&
        !virtualizer.itemSizeCache.has(calls[index].toolCallId)
      )
        virtualizer.resizeItem(
          index,
          virtualizer.options.measureElement(node as HTMLDivElement, undefined, virtualizer),
        );
    }
    if (!following || !followingRef.current) return;
    viewport.scrollTop = viewport.scrollHeight;
  });
  const state = useData((s) => s.state, store);
  const attention = useData((s) => s.attention, store);
  const target = cardTarget({
    selectedId: agentId,
    attention,
    requests: state?.requests ?? {},
    agents: state?.agents ?? {},
  });
  const agents = Object.values(state?.agents ?? {});
  return (
    <div ref={feed} className={styles.feed}>
      {target ? (
        <article className={styles.card}>
          <h3>Needs you: {safe(target.toolName ?? "not reported")}</h3>
          <p>{safe(target.requestId)}</p>
          <p>Session: {safe(target.sessionId ?? "not reported")}</p>
          <Button onPress={() => select(target.agentId)}>Open request action card</Button>
        </article>
      ) : null}
      <div className={styles.follow}>
        {!following ? <Button onPress={() => changeFollow(true)}>Jump to latest</Button> : null}
      </div>
      <div ref={rows} className={styles.rows} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const call = calls[item.index];
          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className={styles.row}
              style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
            >
              <ToolCard
                {...{ call, evidence, evicted, agents, select }}
                expanded={expanded.has(call.toolCallId)}
                toggleExpanded={() =>
                  setExpanded((old) => {
                    const next = new Set(old);
                    if (next.has(call.toolCallId)) next.delete(call.toolCallId);
                    else next.add(call.toolCallId);
                    return next;
                  })
                }
              />
            </div>
          );
        })}
      </div>
      {!calls.length && !target ? <p>No tool calls reported.</p> : null}
    </div>
  );
}
