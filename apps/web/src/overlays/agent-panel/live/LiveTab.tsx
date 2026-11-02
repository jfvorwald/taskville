import {
  elementScroll,
  observeWindowOffset,
  observeWindowRect,
  useVirtualizer,
  type VirtualizerOptions,
  windowScroll,
} from "@tanstack/react-virtual";
import { diffWordsWithSpace } from "diff";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "react-aria-components";
import { type JsonValue, redactJson } from "../../../../../../packages/adapters/src/redact/json.ts";
import { redactText } from "../../../../../../packages/adapters/src/redact/text.ts";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import type { Agent } from "../../../data/domain.ts";
import { useData } from "../../../data/react.ts";
import type { DataStore } from "../../../data/store.ts";
import { visibleControls } from "../../action-card/format.ts";
import { cardTarget } from "../../action-card/target.ts";
import { EVIDENCE_BODY_CAPACITY } from "./evidenceCache.ts";
import styles from "./live.module.css";

export interface LiveTabProps {
  agentId: string;
  store: DataStore;
  select: (id: string | null) => void;
  calls: readonly ToolCallFrame[];
  evidence:
    | Readonly<Record<string, EvidenceResponse>>
    | ((id: string) => EvidenceResponse | undefined);
  /** Internal connected loader: only calls whose details are currently rendered. */
  onVisibleCalls?: (calls: readonly ToolCallFrame[]) => void;
  /** Evidence IDs the server answered 410 evidence_evicted for: the call happened, the body is gone. */
  evicted?: ReadonlySet<string>;
}
type Evicted = ReadonlySet<string>;
/** Redacted, with hidden and reordering characters shown as <U+XXXX>. */
const safe = (text: string) => visibleControls(redactText(text).text);
/** No rendered body is longer than this. A deep or huge body shows a note instead of the rest. */
const CAP = 20_000;
const TRUNCATED = "Display truncated at 20,000 characters";
/**
 * The part of a body that fits CAP characters once its hidden characters are shown, for text that
 * is diffed before the markers go in.
 */
function head(text: string) {
  let width = 0;
  let end = 0;
  for (const char of text) {
    const shown = char < " " || char > "~" ? visibleControls(char).length : 1;
    if (width + shown > CAP) break;
    width += shown;
    end += char.length;
  }
  return { text: text.slice(0, end), truncated: end < text.length };
}
function bounded(text: string): { text: string; truncated: boolean } {
  const head = text.slice(0, CAP);
  const shown = visibleControls(head);
  return shown.length > CAP || head.length < text.length
    ? { text: shown.slice(0, CAP), truncated: true }
    : { text: shown, truncated: false };
}
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
const stringList = (value: unknown) =>
  Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];
const string = (value: unknown) => (typeof value === "string" ? value : undefined);

const parsed = new WeakMap<EvidenceResponse, unknown>();
/** The redacted, parsed body. Parsed once per body object, not on every render. */
function bodyValue(body: EvidenceResponse | undefined): unknown {
  if (!body) return undefined;
  if (parsed.has(body)) return parsed.get(body);
  const value = parseBody(body);
  parsed.set(body, value);
  return value;
}

function parseBody(body: EvidenceResponse): unknown {
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
  // A path with a hidden or reordering character is shown with markers, as text and not a link.
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

/** Rendered text: bounded, with hidden and reordering characters made visible. */
function Bounded({ text, as: Tag = "pre" }: { text: string; as?: "pre" | "p" }) {
  const shown = bounded(text);
  return (
    <>
      <Tag>{shown.text}</Tag>
      {shown.truncated ? <p>{TRUNCATED}</p> : null}
    </>
  );
}

type Ref = ToolCallFrame["evidence"]["input"];
/** The body was stored and is now evicted, by the frame's own status or by the evidence route. */
const isGone = (ref: Ref | undefined, body: EvidenceResponse | undefined, evicted: Evicted) =>
  !body && !!ref && (ref.status === "evicted" || evicted.has(ref.id));
const bodyOfCall = (
  call: ToolCallFrame,
  part: "input" | "output",
  evidence: LiveTabProps["evidence"],
) => {
  const ref = call.evidence?.[part];
  return ref ? (typeof evidence === "function" ? evidence(ref.id) : evidence[ref.id]) : undefined;
};
const oneLine = (text: string) => text.split("\n", 1)[0].slice(0, 120);
/** The pretty printed body of a deep value is large. It is computed once per body, not per render. */
const pretty = (value: unknown) =>
  typeof value === "string" || value === undefined ? value : JSON.stringify(value, null, 2);

const ToolCard = memo(function ToolCard({
  call,
  inputBody,
  outputBody,
  inputGone,
  outputGone,
  agents,
  select,
  expanded,
  toggleExpanded,
  position,
  size,
}: {
  call: ToolCallFrame;
  inputBody: EvidenceResponse | undefined;
  outputBody: EvidenceResponse | undefined;
  inputGone: boolean;
  outputGone: boolean;
  agents: readonly Agent[];
  select: LiveTabProps["select"];
  expanded: boolean;
  toggleExpanded: (id: string) => void;
  position: number;
  size: number;
}) {
  const heading = useId();
  const expand = useId();
  // A reference the hook never sent stays "not reported"; one that was stored then evicted does not.
  const missingInput = inputGone ? EVICTED : "not reported";
  const missingOutput = outputGone ? EVICTED : "not reported";
  const inputValue = bodyValue(inputBody);
  const outputValue = bodyValue(outputBody);
  const input = object(inputValue);
  const output = object(outputValue);
  const paths = [
    ...new Set([
      ...call.filePaths,
      ...[string(input.file_path), string(input.path)].filter((p): p is string => p !== undefined),
      ...stringList(output.filenames),
    ]),
  ];
  const target = targetAgent(call, input, output, agents);
  const old = string(input.old_string);
  const next = string(input.new_string);
  const stdout = string(output.stdout);
  const stderr = string(output.stderr);
  const tool = typeof call.toolName === "string" ? call.toolName : "not reported";
  const inputText = useMemo(() => pretty(inputValue), [inputValue]);
  const outputText = useMemo(() => pretty(outputValue), [outputValue]);
  const fallback = outputText ?? missingOutput;
  const edit = useMemo(
    () =>
      tool === "Edit" && old !== undefined && next !== undefined
        ? { before: head(old), after: head(next) }
        : undefined,
    [tool, old, next],
  );
  const fragment = useMemo(() => {
    if (!edit) return undefined;
    const parts = diffWordsWithSpace(edit.before.text, edit.after.text, {
      timeout: 25,
      maxEditLength: 1000,
    });
    // Equal tokens repeat ("a a"), so a part's own value is no key. Its offset in the diff is one.
    let offset = 0;
    return parts?.map((part) => {
      const key = `${offset}:${part.added ? "+" : part.removed ? "-" : "="}`;
      offset += part.value.length;
      return { ...part, key, value: visibleControls(part.value) };
    });
  }, [edit]);
  const command = string(input.command);
  const isSearch = tool === "Grep" || tool === "Glob" || tool === "Search";
  const subjectPath = tool === "Bash" || isSearch ? undefined : paths[0];
  const subject =
    tool === "Bash"
      ? command
      : isSearch
        ? (string(input.pattern) ?? string(input.query) ?? paths[0])
        : subjectPath;
  // The subject path is in the heading, as the editor link. The rest are listed once, below.
  const otherPaths = paths.filter((path) => path !== subjectPath);
  const phase = string(call.phase) ?? "unknown";
  return (
    <article
      className={styles.card}
      aria-labelledby={heading}
      aria-posinset={position}
      aria-setsize={size}
      tabIndex={-1}
    >
      <h3 id={heading}>
        {safe(tool)}:{" "}
        {subjectPath === undefined ? safe(oneLine(subject ?? phase)) : <Path path={subjectPath} />}
      </h3>
      <p>
        Status: {safe(phase)}. Timing:{" "}
        {typeof call.durationMs === "number" && Number.isFinite(call.durationMs)
          ? `${call.durationMs} ms`
          : "not reported"}
      </p>
      {otherPaths.length || !paths.length ? (
        <p>
          Path:{" "}
          {otherPaths.length
            ? otherPaths.map((path) => (
                <span key={path}>
                  <Path path={path} />{" "}
                </span>
              ))
            : "not reported"}
        </p>
      ) : null}
      {tool === "Edit" ? (
        <div>
          <p>Edit fragment</p>
          {edit ? (
            <>
              {fragment ? (
                fragment.map((part) =>
                  part.added ? (
                    <ins key={part.key}>{part.value}</ins>
                  ) : part.removed ? (
                    <del key={part.key}>{part.value}</del>
                  ) : (
                    <span key={part.key}>{part.value}</span>
                  ),
                )
              ) : (
                <>
                  <p>Original fragment</p>
                  <pre>{visibleControls(edit.before.text)}</pre>
                  <p>Replacement fragment</p>
                  <pre>{visibleControls(edit.after.text)}</pre>
                </>
              )}
              {edit.before.truncated || edit.after.truncated ? <p>{TRUNCATED}</p> : null}
            </>
          ) : (
            <p>Input: {missingInput}</p>
          )}
        </div>
      ) : tool === "Write" ? (
        <Bounded text={string(input.content) ?? inputText ?? missingInput} />
      ) : tool === "Bash" ? (
        <>
          <Bounded as="p" text={command ?? missingInput} />
          <Button
            id={expand}
            {...(subject === undefined ? {} : { "aria-labelledby": `${expand} ${heading}` })}
            aria-expanded={expanded}
            onPress={() => toggleExpanded(call.toolCallId)}
          >
            {expanded ? "Collapse output" : "Expand output"}
          </Button>
          <Bounded
            text={
              stdout === undefined
                ? fallback
                : expanded
                  ? stdout
                  : stdout.replace(/\n$/, "").split("\n").slice(-10).join("\n")
            }
          />
          {stderr ? <Bounded text={stderr} /> : null}
        </>
      ) : tool === "Read" ? null : tool === "Grep" || tool === "Search" || tool === "Glob" ? (
        <>
          <p>Search: {safe(string(input.pattern) ?? string(input.query) ?? missingInput)}</p>
          <Bounded text={fallback} />
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
          <Bounded text={inputText ?? missingInput} />
        </>
      ) : (
        <Bounded text={inputText ?? missingInput} />
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
});

/** A run of Read calls or of Search calls: one card that expands to the files or the patterns. */
function GroupCard({
  kind,
  calls,
  evidence,
  evicted,
  expanded,
  toggleExpanded,
  position,
  size,
  detailPage,
  detailPageSize,
  onDetailPage,
}: {
  kind: "read" | "search";
  calls: readonly ToolCallFrame[];
  evidence: LiveTabProps["evidence"];
  evicted: Evicted;
  expanded: boolean;
  toggleExpanded: (id: string) => void;
  position: number;
  size: number;
  detailPage: number;
  detailPageSize: number;
  onDetailPage: (id: string, page: number) => void;
}) {
  const heading = useId();
  const list = useId();
  const page = groupDetails(calls, detailPage, detailPageSize);
  const settled = calls.filter((call) => call.phase === "succeeded").length;
  return (
    <article
      className={styles.card}
      aria-labelledby={heading}
      aria-posinset={position}
      aria-setsize={size}
      tabIndex={-1}
    >
      <h3 id={heading}>
        {kind === "read" ? `Read ${calls.length} files` : `Searched ${calls.length} times`}
      </h3>
      {settled < calls.length ? (
        <p>
          {[
            ["running", "running"],
            ["failed", "failed"],
            ["unfinished", "unfinished"],
          ]
            .map(
              ([phase, label]) => [calls.filter((c) => c.phase === phase).length, label] as const,
            )
            .filter(([count]) => count > 0)
            .map(([count, label]) => `${count} ${label}`)
            .join(", ")}
        </p>
      ) : null}
      {/* The name stays "Expand ..." in both states; aria-expanded carries the state. */}
      <Button
        aria-expanded={expanded}
        aria-controls={list}
        onPress={() => toggleExpanded(calls[0].toolCallId)}
      >
        {kind === "read" ? "Expand paths" : "Expand patterns"}
      </Button>
      {expanded && page.count > 1 ? (
        <div>
          <Button
            aria-label={kind === "read" ? "Previous read details" : "Previous search details"}
            isDisabled={page.index === 0}
            onPress={() => onDetailPage(calls[0].toolCallId, page.index - 1)}
          >
            Previous
          </Button>
          <span role="status">{`Details page ${page.index + 1} of ${page.count}`}</span>
          <Button
            aria-label={kind === "read" ? "Next read details" : "Next search details"}
            isDisabled={page.index + 1 === page.count}
            onPress={() => onDetailPage(calls[0].toolCallId, page.index + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
      {expanded ? (
        <ul id={list}>
          {page.calls.map((call) => {
            const body = bodyOfCall(call, "input", evidence);
            const output = bodyOfCall(call, "output", evidence);
            const input = object(bodyValue(body));
            const subject =
              kind === "read"
                ? (string(input.file_path) ?? call.filePaths[0])
                : (string(input.pattern) ?? string(input.query));
            // A search lists the files it recorded, from the frame and from the result.
            const hits =
              kind === "search"
                ? [
                    ...new Set([
                      ...call.filePaths,
                      ...stringList(object(bodyValue(output)).filenames),
                    ]),
                  ]
                : [];
            return (
              <li key={call.toolCallId}>
                {subject === undefined ? (
                  isGone(call.evidence?.input, body, evicted) ? (
                    EVICTED
                  ) : call.evidence?.input?.status === "stored" ? (
                    "details not loaded"
                  ) : (
                    "not reported"
                  )
                ) : kind === "read" ? (
                  <Path path={subject} />
                ) : (
                  bounded(subject).text
                )}
                {kind === "search" && isGone(call.evidence?.output, output, evicted) ? (
                  <span> {EVICTED}</span>
                ) : kind === "search" && !output && call.evidence?.output?.status === "stored" ? (
                  <span> details not loaded</span>
                ) : null}
                {call.phase === "succeeded" ? null : <span> ({safe(String(call.phase))})</span>}
                {hits.map((path) => (
                  <span key={path}>
                    {" "}
                    <Path path={path} />
                  </span>
                ))}
              </li>
            );
          })}
        </ul>
      ) : null}
    </article>
  );
}

type Item = { key: string; kind: "call" | "read" | "search"; calls: readonly ToolCallFrame[] };

function groupDetails(calls: readonly ToolCallFrame[], wanted: number, size: number) {
  const count = Math.max(1, Math.ceil(calls.length / size));
  const index = Math.max(0, Math.min(wanted, count - 1));
  return { index, count, calls: calls.slice(index * size, (index + 1) * size) };
}

const RUNS = new Map<string, "read" | "search">([
  ["Read", "read"],
  ["Grep", "search"],
  ["Glob", "search"],
  ["Search", "search"],
]);

/** Consecutive Read calls and consecutive Search calls become one item. Any other call ends a run. */
function group(calls: readonly ToolCallFrame[]): Item[] {
  const items: Item[] = [];
  let run: ToolCallFrame[] = [];
  let kind: "read" | "search" | undefined;
  const close = () => {
    if (run.length === 1) items.push({ key: run[0].toolCallId, kind: "call", calls: run });
    else if (run.length && kind) items.push({ key: run[0].toolCallId, kind, calls: run });
    run = [];
    kind = undefined;
  };
  for (const call of calls) {
    const next = RUNS.get(String(call.toolName));
    if (next === undefined || next !== kind) close();
    if (next === undefined) items.push({ key: call.toolCallId, kind: "call", calls: [call] });
    else {
      kind = next;
      run.push(call);
    }
  }
  close();
  return items;
}

export function LiveTab(props: LiveTabProps) {
  const projectId = useData((s) => s.state?.projectId, props.store);
  return <LiveFeed key={JSON.stringify([projectId, props.agentId])} {...props} />;
}

const NONE: ReadonlySet<string> = new Set();

function LiveFeed({
  agentId,
  store,
  select,
  calls,
  evidence,
  evicted = NONE,
  onVisibleCalls,
}: LiveTabProps) {
  const feed = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  // The offset the virtualizer last wrote, so its measurement corrections are not read as a reader.
  const written = useRef<number | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [detailPages, setDetailPages] = useState<ReadonlyMap<string, number>>(() => new Map());
  const page = viewport && isPage(viewport) ? viewport.ownerDocument.defaultView : null;
  const items = useMemo(() => group(calls), [calls]);
  const focusNewest = useRef(false);
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    ...(page ? pageScroll : {}),
    scrollToFn: (offset, options, instance) => {
      (page ? pageScroll.scrollToFn : elementScroll)(offset, options, instance);
      written.current = viewport?.scrollTop ?? null;
    },
    count: items.length,
    getScrollElement: () => (page as unknown as HTMLElement | null) ?? viewport,
    getItemKey: (index) => items[index].key,
    estimateSize: () => 240,
    overscan: 5,
    scrollMargin,
    useFlushSync: false,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const singleCount = virtualItems.filter(({ index }) => items[index].kind === "call").length;
  const expandedCount = virtualItems.filter(
    ({ index }) => items[index].kind !== "call" && expanded.has(items[index].key),
  ).length;
  // Reserve both body parts per call and share the remaining budget across presented groups.
  const detailPageSize = Math.max(
    1,
    Math.min(
      32,
      Math.floor(
        (Math.floor(EVIDENCE_BODY_CAPACITY / 2) - singleCount) / Math.max(1, expandedCount),
      ),
    ),
  );
  // Report after commit, so even transient follow ranges are genuinely mounted. Collapsed
  // groups show metadata only; their member details become requested when expanded.
  useEffect(() => {
    onVisibleCalls?.(
      virtualItems.flatMap(({ index }) => {
        const item = items[index];
        if (item.kind === "call") return item.calls;
        return expanded.has(item.key)
          ? groupDetails(item.calls, detailPages.get(item.key) ?? 0, detailPageSize).calls
          : [];
      }),
    );
  });
  const onDetailPage = useCallback((id: string, page: number) => {
    setDetailPages((old) => new Map(old).set(id, page));
  }, []);
  useEffect(() => {
    const keys = new Set(items.map((item) => item.key));
    setDetailPages((old) => {
      if ([...old.keys()].every((key) => keys.has(key))) return old;
      return new Map([...old].filter(([key]) => keys.has(key)));
    });
  }, [items]);
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
        focusNewest.current = false;
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
      if (index >= 0 && index < items.length && !virtualizer.itemSizeCache.has(items[index].key))
        virtualizer.resizeItem(
          index,
          virtualizer.options.measureElement(node as HTMLDivElement, undefined, virtualizer),
        );
    }
    if (!following || !followingRef.current) return;
    viewport.scrollTop = viewport.scrollHeight;
    // After Jump to latest the button is gone. Put focus on the newest card once it is mounted.
    if (focusNewest.current) {
      const newest = rows.current?.querySelector<HTMLElement>(
        `[data-index="${items.length - 1}"] article`,
      );
      if (newest) {
        newest.focus({ preventScroll: true });
        focusNewest.current = false;
      }
    }
  });
  const toggleExpanded = useCallback((id: string) => {
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const state = useData((s) => s.state, store);
  const attention = useData((s) => s.attention, store);
  const target = cardTarget({
    selectedId: agentId,
    attention,
    requests: state?.requests ?? {},
    agents: state?.agents ?? {},
  });
  const agentMap = state?.agents;
  const agents = useMemo(() => Object.values(agentMap ?? {}), [agentMap]);
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
        {!following ? (
          <Button
            onPress={() => {
              focusNewest.current = true;
              changeFollow(true);
            }}
          >
            Jump to latest
          </Button>
        ) : null}
      </div>
      <div
        ref={rows}
        role="feed"
        aria-label="Tool calls"
        className={styles.rows}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtual) => {
          const item = items[virtual.index];
          const [call] = item.calls;
          // GroupCard reads only its presented page. Unused gets would keep its first member hot.
          const inputBody = item.kind === "call" ? bodyOfCall(call, "input", evidence) : undefined;
          const outputBody =
            item.kind === "call" ? bodyOfCall(call, "output", evidence) : undefined;
          const common = {
            expanded: expanded.has(item.key),
            toggleExpanded,
            position: virtual.index + 1,
            size: items.length,
          };
          return (
            <div
              key={virtual.key}
              ref={virtualizer.measureElement}
              data-index={virtual.index}
              className={styles.row}
              style={{ transform: `translateY(${virtual.start - scrollMargin}px)` }}
            >
              {item.kind === "call" ? (
                <ToolCard
                  {...common}
                  {...{ call, inputBody, outputBody, agents, select }}
                  inputGone={isGone(call.evidence?.input, inputBody, evicted)}
                  outputGone={isGone(call.evidence?.output, outputBody, evicted)}
                />
              ) : (
                <GroupCard
                  {...common}
                  {...{ evidence, evicted }}
                  kind={item.kind}
                  calls={item.calls}
                  detailPage={detailPages.get(item.key) ?? 0}
                  detailPageSize={detailPageSize}
                  onDetailPage={onDetailPage}
                />
              )}
            </div>
          );
        })}
      </div>
      {!items.length && !target ? <p>No tool calls reported.</p> : null}
    </div>
  );
}
