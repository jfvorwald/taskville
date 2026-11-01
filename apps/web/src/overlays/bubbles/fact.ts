import type { QuipLevel } from "../../quips/index.ts";

/** What a tool name looks like: a short identifier, never a sentence, path, or markup. */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,31}$/;

export interface BubbleFactInput {
  level: QuipLevel;
  /** The request's recorded tool name; used only when it looks like one. */
  toolName?: string | undefined;
}

/**
 * The one short fact a bubble may carry: "Needs OK: Bash". Only a needs-you bubble with an
 * allowlisted tool name gets one. Agent-supplied text never appears in a bubble.
 */
export function bubbleFact({ level, toolName }: BubbleFactInput): string | null {
  if (level !== "needs_you") return null;
  if (typeof toolName !== "string" || !TOOL_NAME.test(toolName)) return null;
  return `Needs OK: ${toolName}`;
}
