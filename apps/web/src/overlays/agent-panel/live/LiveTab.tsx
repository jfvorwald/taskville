import { diffWordsWithSpace } from "diff";
import { useState } from "react";
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
}
const safe = (text: string) => redactText(text).text;
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

function ToolCard({
  call,
  evidence,
  agents,
  select,
}: {
  call: ToolCallFrame;
  evidence: LiveTabProps["evidence"];
  agents: readonly Agent[];
  select: LiveTabProps["select"];
}) {
  const [expanded, setExpanded] = useState(false);
  const inputBody = call.evidence.input ? evidence[call.evidence.input.id] : undefined;
  const outputBody = call.evidence.output ? evidence[call.evidence.output.id] : undefined;
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
      ? "not reported"
      : typeof outputValue === "string"
        ? outputValue
        : JSON.stringify(outputValue, null, 2);
  const tool = typeof call.toolName === "string" ? call.toolName : "not reported";
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
            diffWordsWithSpace(old, next).map((part) =>
              part.added ? (
                <ins key={JSON.stringify(part)}>{part.value}</ins>
              ) : part.removed ? (
                <del key={JSON.stringify(part)}>{part.value}</del>
              ) : (
                <span key={JSON.stringify(part)}>{part.value}</span>
              ),
            )
          ) : (
            <p>Input: not reported</p>
          )}
        </div>
      ) : tool === "Write" ? (
        <pre>{string(input.content) ?? "not reported"}</pre>
      ) : tool === "Bash" ? (
        <>
          <p>{string(input.command) ?? "not reported"}</p>
          <Button onPress={() => setExpanded(!expanded)} aria-expanded={expanded}>
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
            {string(input.pattern) ?? string(input.query) ?? "not reported"}
          </p>
          <pre>{fallback}</pre>
        </>
      ) : tool === "Agent" || tool === "SendMessage" ? (
        <>
          <p>
            {tool === "Agent" ? "Spawned" : "Sent message to"}{" "}
            {target ? (
              <Button onPress={() => select(target.id)}>
                {safe(target.displayName ?? target.id)}
              </Button>
            ) : (
              "not reported"
            )}
          </p>
          <pre>
            {inputValue === undefined ? "not reported" : JSON.stringify(inputValue, null, 2)}
          </pre>
        </>
      ) : (
        <pre>{inputValue === undefined ? "not reported" : JSON.stringify(inputValue, null, 2)}</pre>
      )}
      {tool !== "Bash" &&
      tool !== "Read" &&
      tool !== "Grep" &&
      tool !== "Search" &&
      tool !== "Glob" ? (
        <p>Output: {outputValue === undefined ? "not reported" : "recorded"}</p>
      ) : null}
      {inputBody?.truncated || outputBody?.truncated ? <p>Recorded excerpt truncated</p> : null}
    </article>
  );
}

export function LiveTab({ agentId, store, select, calls, evidence }: LiveTabProps) {
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
    <div className={styles.feed}>
      {target ? (
        <article className={styles.card}>
          <h3>Needs you: {safe(target.toolName ?? "not reported")}</h3>
          <p>{safe(target.requestId)}</p>
          <p>Session: {safe(target.sessionId ?? "not reported")}</p>
          <Button onPress={() => select(target.agentId)}>Open request action card</Button>
        </article>
      ) : null}
      {calls.map((call) => (
        <ToolCard key={call.toolCallId} {...{ call, evidence, agents, select }} />
      ))}
      {!calls.length && !target ? <p>No tool calls reported.</p> : null}
    </div>
  );
}
