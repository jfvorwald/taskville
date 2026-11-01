// The card hides what the engine's redactor would mask in the event log. The redactor is pure with
// no Node-only imports, so it is called here by relative path, the way `data/domain.ts` reaches
// the shared packages, instead of copying its rules.
import { redactText } from "../../../../../packages/adapters/src/redact/text.ts";

/** A secret-looking part of an input: UTF-16 offsets into the text, half-open. */
export interface MaskSpan {
  kind: string;
  start: number;
  end: number;
}

/** The secret spans of `text`, sorted and never overlapping. */
export function maskSpans(text: string): MaskSpan[] {
  return redactText(text).spans.map(({ kind, start, end }) => ({ kind, start, end }));
}
