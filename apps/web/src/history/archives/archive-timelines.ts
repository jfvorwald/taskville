import type { StoredEnvelope } from "../../data/domain.ts";

export const LIVE_LABEL = "Live recording";

export type GitMarker = "Git commit" | "Git ref moved" | "Git merge";

/** One entry of the timeline picker: the live recording or an imported archive. */
export interface TimelineChoice {
  readonly id: string;
  readonly kind: "live" | "archive";
  readonly archiveKind: string | undefined;
  readonly label: string;
  readonly firstAt: string;
  readonly lastAt: string;
  /** NaN when malformed: the provider rejects a position it cannot walk. */
  readonly firstSequence: number;
  readonly lastSequence: number;
}

const archiveKinds: Readonly<Record<string, string>> = {
  git: "Git",
  transcripts: "Transcripts",
};

export const archiveKindName = (archiveKind: string | undefined) =>
  archiveKind === undefined ? "Archive" : (archiveKinds[archiveKind] ?? archiveKind);

/** The live recording first, then well-formed archives of this project by label. */
export function timelineChoices(body: { timelines: readonly unknown[] }, projectId: string) {
  const live: TimelineChoice[] = [];
  const archives: TimelineChoice[] = [];
  for (const raw of body.timelines) {
    const item = raw as Record<string, unknown> | null;
    if (!item || item.projectId !== projectId || typeof item.id !== "string") continue;
    const { id, kind, label, firstAt, lastAt, archiveKind } = item;
    const firstSequence = typeof item.firstSequence === "number" ? item.firstSequence : Number.NaN;
    const lastSequence = typeof item.lastSequence === "number" ? item.lastSequence : Number.NaN;
    if (typeof firstAt !== "string" || typeof lastAt !== "string") continue;
    if (kind === "live" && id === `live:${projectId}`) {
      live.push({
        id,
        kind,
        archiveKind: undefined,
        label: LIVE_LABEL,
        firstAt,
        lastAt,
        firstSequence,
        lastSequence,
      });
    } else if (kind === "archive" && id.startsWith("archive:") && typeof label === "string") {
      const named = typeof archiveKind === "string" ? archiveKind : undefined;
      archives.push({
        id,
        kind,
        archiveKind: named,
        label,
        firstAt,
        lastAt,
        firstSequence,
        lastSequence,
      });
    }
  }
  archives.sort((a, b) => a.label.localeCompare(b.label));
  return [...live, ...archives];
}

/** Live and archive options read the same: label, kind, then the occurred date range. */
export function choiceText(choice: TimelineChoice): string {
  if (choice.kind === "live") return choice.label;
  const first = new Date(choice.firstAt).toLocaleDateString();
  const last = new Date(choice.lastAt).toLocaleDateString();
  const range = first === last ? first : `${first} to ${last}`;
  return `${choice.label} · ${archiveKindName(choice.archiveKind)} · ${range}`;
}

/** The live recording is received time. An archive is placed by when its events occurred. */
export const momentTime = (choice: TimelineChoice, event: StoredEnvelope) =>
  Date.parse(choice.kind === "archive" ? event.occurredAt : event.receivedAt);

export function gitMarker(event: StoredEnvelope): GitMarker | undefined {
  if (event.type === "git.commit") return "Git commit";
  if (event.type === "git.ref_moved") return "Git ref moved";
  if (event.type === "git.merge") return "Git merge";
  return undefined;
}

export const GIT_GLYPH: Readonly<Record<GitMarker, string>> = {
  "Git commit": "◆",
  "Git ref moved": "→",
  "Git merge": "◈",
};
