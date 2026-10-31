import { z } from "zod";

/** Max length of any ID field (data-model.md validation table). */
export const ID_MAX_LENGTH = 200;
/** Max stored reason length, in Unicode code points, after masking (FR-017). */
export const REASON_MAX_CHARS = 280;
/** Max input reason length, in code points, before masking and truncation; longer is rejected. */
export const INPUT_REASON_MAX_CHARS = 4000;
/** Max `request.opened` input preview length, in code points. */
export const INPUT_PREVIEW_MAX_CHARS = 2000;

/** Length in Unicode code points, so a limit never splits a surrogate pair. */
export const codePointLength = (text: string): number => {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
};

// JSON Schema's maxLength counts code points too, so the exported schema states the same limit.
const maxCodePoints = (max: number) =>
  z
    .string()
    .refine((text) => codePointLength(text) <= max, {
      message: `Must be at most ${max} characters`,
      abort: true,
    })
    .meta({ maxLength: max });

/** An opaque identifier: non-empty, at most 200 characters. */
export const idSchema = z.string().min(1).max(ID_MAX_LENGTH);

/** ISO-8601 timestamp with a UTC offset (`Z` or `+hh:mm`). */
export const timestampSchema = z.iso.datetime({ offset: true });

/** Git object name: 7 to 64 lowercase hex characters (abbreviated, SHA-1, or SHA-256). */
export const shaSchema = z.string().regex(/^[0-9a-f]{7,64}$/, "Must be a lowercase hex Git SHA");

export const nonNegativeIntSchema = z.int().nonnegative();
export const positiveIntSchema = z.int().positive();

/** Free text supplied by an agent or source. The engine masks it before storing (events.md). */
export const textSchema = z.string();
export const nonEmptyTextSchema = z.string().min(1);

/** A reason as producers send it: plain text, at most 4,000 characters. */
export const inputReasonSchema = maxCodePoints(INPUT_REASON_MAX_CHARS);

/** A reason as stored: masked, then cut to 280 characters, with flags saying which happened. */
export const storedReasonSchema = z.strictObject({
  text: maxCodePoints(REASON_MAX_CHARS),
  masked: z.boolean(),
  truncated: z.boolean(),
});
export type StoredReason = z.output<typeof storedReasonSchema>;

export const inputPreviewSchema = maxCodePoints(INPUT_PREVIEW_MAX_CHARS);

/** Absolute directory path: POSIX `/...`, Windows `C:\...`, or UNC `\\server\...`. */
export const absolutePathSchema = z
  .string()
  .regex(/^(\/|[A-Za-z]:[\\/]|\\\\)/, "Must be an absolute path");

export const PROVENANCES = ["live", "imported", "demo"] as const;
export const provenanceSchema = z.enum(PROVENANCES);
export type Provenance = z.output<typeof provenanceSchema>;

export const SCHEMA_VERSION = 1;
