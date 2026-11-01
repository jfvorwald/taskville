import type { Attention } from "../../data/domain.ts";

// The text after "Trouble:" in the agent label. Silent trouble is a guess and says so; its
// minutes come from the attention selector's `reason.text`, so nothing here reads a clock.

export interface TroubleDetail {
  readonly text: string;
  /** True for guesses (silent trouble); recorded failures are facts. */
  readonly heuristic: boolean;
}

export function troubleDetail(record: Attention | undefined): TroubleDetail | undefined {
  if (record === undefined || record.level !== "trouble") return undefined;
  switch (record.kind) {
    case "silent":
      return { text: record.reason?.text ?? "quiet", heuristic: true };
    case "stop_failure":
      return { text: "turn failed", heuristic: false };
    case "tool_failures":
      return { text: "tool failures", heuristic: false };
    default:
      return undefined;
  }
}
