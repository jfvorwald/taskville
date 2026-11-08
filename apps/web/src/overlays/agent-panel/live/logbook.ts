import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";

// Pure text for a logbook entry: its state, sentence, duration and secondary line. Everything here
// returns raw recorded text; the caller redacts it and makes hidden characters visible.

export type EntryState = "succeeded" | "failed" | "running" | "unfinished" | "needs-you";
export const STATE_LABEL: Readonly<Record<EntryState, string>> = {
  succeeded: "Succeeded",
  failed: "Failed",
  running: "Running",
  unfinished: "Unfinished",
  "needs-you": "Needs you",
};
/** A sentence is plain text with at most one monospace part per piece. */
export type Segment = string | { mono: string };
export const segmentText = (segments: readonly Segment[]) =>
  segments.map((part) => (typeof part === "string" ? part : part.mono)).join("");

/** A call more than this long after the previous one starts a new turn. */
export const TURN_GAP_MS = 2 * 60_000;
/** The secondary line is plain text of at most this many characters. */
export const SECONDARY_MAX = 200;

const string = (value: unknown) => (typeof value === "string" ? value : undefined);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function stateOf(phase: ToolCallFrame["phase"] | string): Exclude<EntryState, "needs-you"> {
  return phase === "succeeded" || phase === "failed" || phase === "running" ? phase : "unfinished";
}

/** The first non-empty line, trimmed. */
export const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

/** A line cut to the secondary-line limit, with an ellipsis when it was cut. */
export const capLine = (text: string) =>
  text.length > SECONDARY_MAX ? `${text.slice(0, SECONDARY_MAX - 1)}…` : text;

export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Lines in a fragment, counted without splitting it. */
function lineCount(text: string) {
  if (text === "") return 0;
  let count = 1;
  for (let i = 0; i < text.length - 1; i++) if (text[i] === "\n") count++;
  return count;
}

const host = (url: string | undefined) => {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
};

/**
 * The one-line sentence from the tool and its key field. It never carries code or output text:
 * the command, a file name, a count, a pattern, a host or a recipient only. Under privacy it reads
 * recorded file paths and nothing from a body.
 */
export function sentenceFor(
  call: ToolCallFrame,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  paths: readonly string[],
  privacy: boolean,
): Segment[] {
  const tool = typeof call.toolName === "string" ? call.toolName : "a tool";
  const state = stateOf(call.phase);
  const file = paths[0] === undefined ? undefined : baseName(paths[0]);
  if (state === "running") return [`Running ${tool}`];
  const subagent = privacy ? undefined : string(input.subagent_type);
  const recipient = privacy ? undefined : (string(input.recipient) ?? string(input.to));
  switch (tool) {
    case "Bash": {
      const command = privacy ? undefined : firstLine(string(input.command) ?? "");
      return command ? ["Ran ", { mono: command }] : ["Ran a command"];
    }
    case "Edit": {
      const added =
        !privacy && string(input.new_string) !== undefined && string(input.old_string) !== undefined
          ? ` +${lineCount(input.new_string as string)} −${lineCount(input.old_string as string)}`
          : "";
      return file ? ["Edited ", { mono: file }, added] : ["Edited a file"];
    }
    case "Write":
      return file ? ["Wrote ", { mono: file }] : ["Wrote a file"];
    case "Read":
      return file ? ["Read ", { mono: file }] : ["Read a file"];
    case "Grep":
    case "Glob":
    case "Search": {
      const query = privacy ? undefined : (string(input.pattern) ?? string(input.query));
      return query ? [`Searched "${firstLine(query)}"`] : ["Searched files"];
    }
    case "Agent":
    case "Task": {
      const helper = subagent ? `${subagent} helper` : "a helper";
      if (state === "failed" || output.success === false) return [`Spawn failed for ${helper}`];
      return state === "unfinished" ? [`No result for spawn of ${helper}`] : [`Spawned ${helper}`];
    }
    case "SendMessage": {
      const to = recipient ? recipient : undefined;
      if (state === "failed" || output.success === false)
        return [to ? `Message to ${to} failed` : "Message failed"];
      if (state === "unfinished")
        return [to ? `No result for message to ${to}` : "No result for message"];
      return [to ? `Sent ${to} a message` : "Sent a message"];
    }
    case "WebFetch": {
      const name = privacy ? undefined : host(string(input.url));
      return name ? [`Fetched ${name}`] : ["Fetched a page"];
    }
    default:
      return [`Used ${tool}`];
  }
}

/** The first line of a failure: stderr, then the recorded error, then stdout. */
function failureLine(output: Record<string, unknown>) {
  for (const key of ["stderr", "error", "message", "stdout"]) {
    const line = firstLine(string(output[key]) ?? "");
    if (line) return line;
  }
  return undefined;
}

/** The text of a SendMessage body: a string, or the content of a message object. */
function messageText(message: unknown) {
  if (typeof message === "string") return message;
  const fields = object(message);
  return string(fields.content) ?? string(fields.message) ?? string(fields.text);
}

/** One plain line under the sentence, or nothing. Never from a body under privacy. */
export function secondaryFor(
  call: ToolCallFrame,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  privacy: boolean,
): string | undefined {
  if (privacy) return undefined;
  if (call.phase === "failed") {
    const failure = failureLine(output);
    if (failure) return failure;
  }
  const tool = String(call.toolName);
  const text =
    tool === "SendMessage"
      ? messageText(input.message)
      : (string(input.description) ??
        (call.phase === "running" ? string(input.command) : undefined));
  const line = firstLine(text ?? "");
  return line === "" ? undefined : line;
}

export function durationFor(call: ToolCallFrame): string | undefined {
  if (call.phase === "running") return "running";
  return typeof call.durationMs === "number" && Number.isFinite(call.durationMs)
    ? `${call.durationMs} ms`
    : undefined;
}

/** The local time of a turn, "12:04", or nothing for an unreadable timestamp. */
const clock = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
export function turnTime(startedAt: string | undefined): number | undefined {
  if (startedAt === undefined) return undefined;
  const ms = Date.parse(startedAt);
  return Number.isFinite(ms) ? ms : undefined;
}
export const formatTurn = (ms: number) => clock.format(new Date(ms));
