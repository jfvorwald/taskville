import { describe, expect, it } from "vitest";
import {
  type AttributionAgent,
  crewAttribution,
} from "../../../../src/city/crew/attention/attribution.ts";
import type { Attention } from "../../../../src/data/domain.ts";

// M5.21 (#334, from the M5.10 review): the lead's "for:" label must follow the same record the
// action card opens (overlays/action-card/target.ts: the FIRST needs_you record with a request,
// of any kind, in attention() order). The label shows only when that first record is heuristic.
// Before this change the label followed the first HEURISTIC record, so an older direct (non-
// heuristic) prompt of the lead, with a later guessed worker prompt behind it, wrongly got a label
// for a request the card does not show.

const agents: Record<string, AttributionAgent> = {
  lead: { id: "lead", kind: "lead", teamId: "t1" },
  pip: { id: "pip", kind: "teammate", teamId: "t1" },
};
const teams = { t1: { leadAgentId: "lead" } };

const record = (since: string, heuristic: boolean, reasonText?: string): Attention =>
  ({
    agentId: "lead",
    level: "needs_you",
    kind: "permission",
    since,
    heuristic,
    requestId: `r-${since}`,
    ...(reasonText === undefined ? {} : { reason: { text: reasonText } }),
  }) as unknown as Attention;

const labelsFor = (attention: readonly Attention[]) =>
  crewAttribution({ agents, teams, attention }).forLabels;

describe("the lead's 'for:' label follows the first needs-you record of any kind", () => {
  it("shows no label when an older non-heuristic record precedes a heuristic one", () => {
    const older = record("2026-11-01T10:00:00.000Z", false, "Bash wants to run");
    const newer = record("2026-11-01T10:01:00.000Z", true, "for: pip (Bash)");
    expect(labelsFor([older, newer])).toEqual({});
  });

  it("still labels the lead when the heuristic record is first", () => {
    const older = record("2026-11-01T10:00:00.000Z", true, "for: pip (Bash)");
    const newer = record("2026-11-01T10:01:00.000Z", false, "Read wants to run");
    expect(labelsFor([older, newer])).toEqual({ lead: { text: "for: pip", heuristic: true } });
  });

  it("keeps the lead red either way (only the label is withheld)", () => {
    const older = record("2026-11-01T10:00:00.000Z", false);
    const newer = record("2026-11-01T10:01:00.000Z", true, "for: pip (Bash)");
    expect(crewAttribution({ agents, teams, attention: [older, newer] }).red).toEqual(["lead"]);
  });

  it("ignores a non-needs-you record ahead of the heuristic one", () => {
    const trouble = {
      ...record("2026-11-01T10:00:00.000Z", false),
      level: "trouble",
    } as unknown as Attention;
    const guessed = record("2026-11-01T10:01:00.000Z", true, "for: pip (Bash)");
    expect(labelsFor([trouble, guessed])).toEqual({ lead: { text: "for: pip", heuristic: true } });
  });
});
