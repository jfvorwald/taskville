import { describe, expect, it } from "vitest";
import {
  type AttentionFeed,
  applyAttentionFrame,
  decideDesktopNotifications,
  EMPTY_ATTENTION_FEED,
  formatTabTitle,
  isDesktopNotificationsEnabled,
  selectAttentionHeader,
} from "../../../src/overlays/header/attention.ts";

// M4.01 web logic, all pure. The feed state is the latest `{ projectId, name, attention }` per
// project that has a needs_you or trouble record, keyed by projectId. It is built from the
// engine's `GET /v1/attention/events` frames (see apps/engine/test/stream/attention.test.ts).

const T = "2026-10-30T11:00:00.000Z";

const needsYou = (agentId: string, requestId: string) => ({
  agentId,
  level: "needs_you" as const,
  kind: "permission" as const,
  since: T,
  requestId,
  heuristic: false,
});

const trouble = (agentId: string) => ({
  agentId,
  level: "trouble" as const,
  kind: "stop_failure" as const,
  since: T,
  heuristic: false,
});

type Attention = ReturnType<typeof needsYou> | ReturnType<typeof trouble>;

const project = (projectId: string, attention: Attention[], name = projectId) => ({
  projectId,
  name,
  attention,
});

const feedOf = (...projects: ReturnType<typeof project>[]): AttentionFeed =>
  Object.fromEntries(projects.map((p) => [p.projectId, p]));

describe("applyAttentionFrame", () => {
  it("replaces the whole feed with a snapshot frame", () => {
    const before = feedOf(project("gamma", [needsYou("a", "r0")]));
    const after = applyAttentionFrame(before, {
      event: "snapshot",
      data: { projects: [project("beta", [needsYou("a", "r1")])], computedAt: T },
    });
    expect(after).toEqual(feedOf(project("beta", [needsYou("a", "r1")])));
  });

  it("sets one project from an attention frame and leaves the others alone", () => {
    const before = feedOf(project("alpha", [trouble("a")]));
    const after = applyAttentionFrame(before, {
      event: "attention",
      data: { ...project("beta", [needsYou("b", "r1")], "Beta"), computedAt: T },
    });
    expect(after).toEqual(
      feedOf(project("alpha", [trouble("a")]), project("beta", [needsYou("b", "r1")], "Beta")),
    );
  });

  it("drops a project whose attention frame is empty", () => {
    const before = feedOf(project("alpha", [trouble("a")]), project("beta", [needsYou("b", "r1")]));
    const after = applyAttentionFrame(before, {
      event: "attention",
      data: { ...project("beta", []), computedAt: T },
    });
    expect(after).toEqual(feedOf(project("alpha", [trouble("a")])));
  });

  it("returns the same object for a heartbeat or an unknown frame, and never mutates its input", () => {
    const before = Object.freeze(feedOf(project("alpha", [trouble("a")])));
    expect(applyAttentionFrame(before, { event: "heartbeat", data: {} })).toBe(before);
    expect(applyAttentionFrame(before, { event: "mystery", data: { x: 1 } })).toBe(before);
    expect(
      applyAttentionFrame(before, {
        event: "attention",
        data: { ...project("beta", [needsYou("b", "r1")]), computedAt: T },
      }),
    ).not.toBe(before);
    expect(Object.keys(before)).toEqual(["alpha"]);
  });

  it("starts empty", () => {
    expect(EMPTY_ATTENTION_FEED).toEqual({});
  });
});

describe("selectAttentionHeader", () => {
  it("is empty for an empty feed", () => {
    expect(selectAttentionHeader(EMPTY_ATTENTION_FEED, "alpha")).toEqual({
      needsYouTotal: 0,
      otherProjects: [],
    });
  });

  it("totals needs-you across every project, the current one included", () => {
    const feed = feedOf(
      project("alpha", [needsYou("a1", "r1")]),
      project("beta", [needsYou("b1", "r2"), needsYou("b2", "r3")], "Beta"),
    );
    expect(selectAttentionHeader(feed, "alpha")).toEqual({
      needsYouTotal: 3,
      otherProjects: [{ projectId: "beta", name: "Beta", needsYou: 2 }],
    });
  });

  it("counts agents, not requests, like the status counts", () => {
    const feed = feedOf(project("beta", [needsYou("b1", "r1"), needsYou("b1", "r2")]));
    expect(selectAttentionHeader(feed, "alpha")).toEqual({
      needsYouTotal: 1,
      otherProjects: [{ projectId: "beta", name: "beta", needsYou: 1 }],
    });
  });

  it("lists only other projects that need you; trouble alone is not a chip and not a count", () => {
    const feed = feedOf(
      project("alpha", [needsYou("a1", "r1")]),
      project("beta", [trouble("b1")]),
      project("gamma", [trouble("g1"), needsYou("g2", "r2")]),
    );
    expect(selectAttentionHeader(feed, "alpha")).toEqual({
      needsYouTotal: 2,
      otherProjects: [{ projectId: "gamma", name: "gamma", needsYou: 1 }],
    });
  });

  it("sorts chips by most needs-you first, then by name", () => {
    const feed = feedOf(
      project("p1", [needsYou("a", "r1")], "Zed"),
      project("p2", [needsYou("b", "r2"), needsYou("c", "r3")], "Mid"),
      project("p3", [needsYou("d", "r4")], "Amy"),
    );
    expect(selectAttentionHeader(feed, "other").otherProjects.map((p) => p.name)).toEqual([
      "Mid",
      "Amy",
      "Zed",
    ]);
  });

  it("treats every project as another one when none is current", () => {
    const feed = feedOf(project("alpha", [needsYou("a1", "r1")]));
    expect(selectAttentionHeader(feed, null).otherProjects).toEqual([
      { projectId: "alpha", name: "alpha", needsYou: 1 },
    ]);
  });
});

describe("formatTabTitle", () => {
  it("shows the count in parentheses before the name", () => {
    expect(formatTabTitle(1)).toBe("(1) Taskville");
    expect(formatTabTitle(12)).toBe("(12) Taskville");
  });

  it("is just the name when nothing needs you", () => {
    expect(formatTabTitle(0)).toBe("Taskville");
  });

  it("treats junk counts as zero or whole numbers", () => {
    expect(formatTabTitle(-3)).toBe("Taskville");
    expect(formatTabTitle(Number.NaN)).toBe("Taskville");
    expect(formatTabTitle(2.9)).toBe("(2) Taskville");
  });
});

describe("isDesktopNotificationsEnabled", () => {
  const settings = (stored: Record<string, unknown>) => ({
    get: <T>(key: string, fallback: T): T => (key in stored ? (stored[key] as T) : fallback),
    set: () => {},
  });

  it("is off by default", () => {
    expect(isDesktopNotificationsEnabled(settings({}))).toBe(false);
  });

  it("is on only when the viewer stored true under desktopNotifications", () => {
    expect(isDesktopNotificationsEnabled(settings({ desktopNotifications: true }))).toBe(true);
    expect(isDesktopNotificationsEnabled(settings({ desktopNotifications: false }))).toBe(false);
    expect(isDesktopNotificationsEnabled(settings({ desktopNotifications: "yes" }))).toBe(false);
    expect(isDesktopNotificationsEnabled(settings({ somethingElse: true }))).toBe(false);
  });
});

describe("decideDesktopNotifications", () => {
  const before = feedOf(project("alpha", [needsYou("a1", "r1")], "Alpha"));
  const after = feedOf(
    project("alpha", [needsYou("a1", "r1")], "Alpha"),
    project("beta", [needsYou("b1", "r2")], "Beta"),
  );
  const hidden = { visible: false, focused: false, projectId: "alpha" };

  const base = {
    previous: before,
    next: after,
    enabled: true,
    permission: "granted" as const,
    view: hidden,
  };

  it("raises one notification for a new needs-you, naming the project and agent", () => {
    expect(decideDesktopNotifications(base)).toEqual([
      {
        key: expect.any(String),
        projectId: "beta",
        projectName: "Beta",
        agentId: "b1",
        requestId: "r2",
      },
    ]);
  });

  it("uses a key that is stable for the agent's entry, so a caller can dedupe", () => {
    const [first] = decideDesktopNotifications(base);
    const [second] = decideDesktopNotifications({
      ...base,
      view: { ...hidden, projectId: "beta" },
    });
    expect(first?.key).toBe(second?.key);
    const other = feedOf(project("beta", [needsYou("b2", "r9")], "Beta"));
    const [third] = decideDesktopNotifications({
      ...base,
      previous: EMPTY_ATTENTION_FEED,
      next: other,
    });
    expect(third?.key).not.toBe(first?.key);
  });

  it("does not fire again when the same needs-you shows up in a later frame (a pulse)", () => {
    expect(decideDesktopNotifications({ ...base, previous: after, next: after })).toEqual([]);
    // A new frame object with equal content, as every attention frame produces.
    const copy = feedOf(
      project("alpha", [needsYou("a1", "r1")], "Alpha"),
      project("beta", [needsYou("b1", "r2")], "Beta"),
    );
    expect(decideDesktopNotifications({ ...base, previous: after, next: copy })).toEqual([]);
  });

  it("does not fire for trouble, or for a needs-you that went away", () => {
    const withTrouble = feedOf(
      project("alpha", [needsYou("a1", "r1")]),
      project("beta", [trouble("b1")]),
    );
    expect(decideDesktopNotifications({ ...base, previous: before, next: withTrouble })).toEqual(
      [],
    );
    expect(decideDesktopNotifications({ ...base, previous: after, next: before })).toEqual([]);
  });

  it("fires once for each agent that enters needs-you when several arrive together", () => {
    const next = feedOf(
      project("alpha", [needsYou("a1", "r1"), needsYou("a2", "r3")], "Alpha"),
      project("beta", [needsYou("b1", "r2")], "Beta"),
    );
    const fired = decideDesktopNotifications({ ...base, previous: before, next });
    expect(fired.map((n) => n.requestId).sort()).toEqual(["r2", "r3"]);
  });

  it("fires once per entry into needs-you, not per request: an agent already needing you stays quiet", () => {
    // A second request from an agent that was already in needs-you is not an entry.
    const next = feedOf(project("alpha", [needsYou("a1", "r1"), needsYou("a1", "r5")], "Alpha"));
    expect(decideDesktopNotifications({ ...base, previous: before, next })).toEqual([]);
  });

  it("does not notify again when the requestId changes for an agent that stays in needs-you", () => {
    // Telemetry opened the prompt, then the bridge took it: same prompt, new requestId, so the
    // reducer replaces the record (ARCHITECTURE 2.2: one prompt, one red state).
    const telemetry = feedOf(project("alpha", [needsYou("a1", "tel-1")], "Alpha"));
    const bridge = feedOf(project("alpha", [needsYou("a1", "bridge-1")], "Alpha"));
    expect(decideDesktopNotifications({ ...base, previous: telemetry, next: bridge })).toEqual([]);
  });

  it("notifies again when an agent leaves needs-you and later re-enters it", () => {
    const needing = feedOf(project("alpha", [needsYou("a1", "r1")], "Alpha"));
    const cleared = EMPTY_ATTENTION_FEED;
    const reentered = feedOf(project("alpha", [needsYou("a1", "r2")], "Alpha"));
    expect(decideDesktopNotifications({ ...base, previous: needing, next: cleared })).toEqual([]);
    expect(
      decideDesktopNotifications({ ...base, previous: cleared, next: reentered }).map(
        (n) => n.agentId,
      ),
    ).toEqual(["a1"]);
    // Trouble in between counts as having left needs-you.
    const troubled = feedOf(project("alpha", [trouble("a1")], "Alpha"));
    expect(
      decideDesktopNotifications({ ...base, previous: troubled, next: reentered }),
    ).toHaveLength(1);
  });

  it("notifies once for each of two different agents that enter needs-you together", () => {
    const next = feedOf(
      project("alpha", [needsYou("a1", "r1")], "Alpha"),
      project("beta", [needsYou("b1", "r2"), needsYou("b2", "r3")], "Beta"),
    );
    const fired = decideDesktopNotifications({ ...base, previous: before, next });
    expect(fired.map((n) => n.agentId).sort()).toEqual(["b1", "b2"]);
  });

  it("tells agents apart per project: the same agent ID entering in another project notifies", () => {
    const next = feedOf(
      project("alpha", [needsYou("a1", "r1")], "Alpha"),
      project("beta", [needsYou("a1", "r7")], "Beta"),
    );
    const fired = decideDesktopNotifications({ ...base, previous: before, next });
    expect(fired.map((n) => n.projectId)).toEqual(["beta"]);
  });

  it("does nothing for the first snapshot, whose needs-you were already there when the page opened", () => {
    expect(decideDesktopNotifications({ ...base, previous: undefined })).toEqual([]);
  });

  it("does nothing while the setting is off, and the setting alone is not enough", () => {
    expect(decideDesktopNotifications({ ...base, enabled: false })).toEqual([]);
  });

  it("does nothing unless the browser granted permission", () => {
    expect(decideDesktopNotifications({ ...base, permission: "default" })).toEqual([]);
    expect(decideDesktopNotifications({ ...base, permission: "denied" })).toEqual([]);
  });

  it("stays quiet when the tab is visible and focused on that project", () => {
    const view = { visible: true, focused: true, projectId: "beta" };
    expect(decideDesktopNotifications({ ...base, view })).toEqual([]);
  });

  it("still fires when the tab is visible and focused but on a different project", () => {
    const view = { visible: true, focused: true, projectId: "alpha" };
    expect(decideDesktopNotifications({ ...base, view })).toHaveLength(1);
  });

  it("fires when the tab is visible but not focused, or hidden, even on that project", () => {
    expect(
      decideDesktopNotifications({
        ...base,
        view: { visible: true, focused: false, projectId: "beta" },
      }),
    ).toHaveLength(1);
    expect(
      decideDesktopNotifications({
        ...base,
        view: { visible: false, focused: false, projectId: "beta" },
      }),
    ).toHaveLength(1);
  });
});
