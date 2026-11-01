import type { ActivityView, AgentView } from "./types.ts";

// Name and status text for the world-labels slot. Status updates the instant state changes, so
// this is a pure function of the view. Agent-supplied names are cleaned here and still rendered
// as text, never as markup (ARCHITECTURE 2.3).

export interface AgentLabel {
  readonly name: string;
  readonly status: string;
}

const NAME_MAX = 24;
const ID_SHORT = 8;

const ACTIVITY_TEXT: Record<ActivityView, string> = {
  idle: "Idle",
  implementing: "Implementing",
  testing: "Testing",
  reviewing: "Reviewing",
  researching: "Researching",
  documenting: "Documenting",
  dispatching: "Dispatching",
  handing_off: "Handing off",
  waiting: "Waiting",
  unknown: "Working",
};

export function agentLabel(v: AgentView): AgentLabel {
  return { name: labelName(v), status: labelStatus(v) };
}

function labelName(v: AgentView): string {
  const cleaned = clean(v.displayName ?? "");
  if (cleaned === "") return cutUnits(v.id, ID_SHORT);
  return cleaned.length > NAME_MAX ? `${cutUnits(cleaned, NAME_MAX - 3)}...` : cleaned;
}

/** The longest prefix of at most `max` UTF-16 code units that never splits a surrogate pair. */
function cutUnits(text: string, max: number): string {
  let out = "";
  for (const ch of Array.from(text)) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

function labelStatus(v: AgentView): string {
  const a = v.attention;
  if (a !== undefined) {
    if (a.level === "needs_you") return "Needs you";
    if (a.level === "waiting") return "Waiting";
    const detail = a.detail === undefined ? "" : clean(a.detail);
    return detail === "" ? "Trouble" : `Trouble: ${detail}`;
  }
  return ACTIVITY_TEXT[v.activity];
}

/** Drops control, format and bidi-override characters; collapses spaces. */
function clean(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
