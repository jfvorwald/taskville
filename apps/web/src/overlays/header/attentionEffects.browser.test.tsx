import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { getSettingsStore } from "../settings/store.ts";
import type { AttentionFeed } from "./attention.ts";
import { useAttentionTabTitle, useDesktopNotifications } from "./attentionEffects.ts";
import { type AttentionStore, createAttentionStore } from "./attentionSync.ts";

// M4.01: the two effects that reach outside the page. The tab title shows how many agents need
// you in every project; a desktop notification is raised for a new needs-you in another project,
// but only when the viewer opted in and the browser granted permission.

const T = "2026-10-30T11:00:00.000Z";
const record = (agentId: string, requestId: string) => ({
  agentId,
  level: "needs_you" as const,
  kind: "permission" as const,
  since: T,
  requestId,
  heuristic: false,
});
const project = (projectId: string, name: string, ...agents: string[]) => ({
  projectId,
  name,
  attention: agents.map((a) => record(a, `req-${projectId}-${a}`)),
});
const feedOf = (...projects: ReturnType<typeof project>[]): AttentionFeed =>
  Object.fromEntries(projects.map((p) => [p.projectId, p]));

function Effects({ store }: { store: AttentionStore }) {
  useAttentionTabTitle(store);
  useDesktopNotifications(store);
  return null;
}

describe("tab title", () => {
  let store: AttentionStore;
  beforeEach(() => {
    store = createAttentionStore();
  });
  afterEach(() => {
    document.title = "";
  });

  it("shows (N) Taskville from the needs-you count across projects, and Taskville at zero", async () => {
    await render(<Effects store={store} />);
    expect(document.title).toBe("Taskville");

    store.setState({
      feed: feedOf(project("unsorted", "Unsorted", "a"), project("beta", "Beta", "b", "c")),
      ready: true,
    });
    await vi.waitFor(() => expect(document.title).toBe("(3) Taskville"));

    store.setState({ feed: feedOf(project("beta", "Beta", "b")) });
    await vi.waitFor(() => expect(document.title).toBe("(1) Taskville"));

    store.setState({ feed: feedOf() });
    await vi.waitFor(() => expect(document.title).toBe("Taskville"));
  });
});

describe("desktop notifications", () => {
  const calls: { title: string; options: NotificationOptions | undefined }[] = [];
  let store: AttentionStore;

  function stubNotification(permission: NotificationPermission) {
    class FakeNotification {
      static permission = permission;
      onclick: (() => void) | null = null;
      constructor(title: string, options?: NotificationOptions) {
        calls.push({ title, options });
      }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
  }

  beforeEach(() => {
    calls.length = 0;
    store = createAttentionStore();
    selectProject(DEFAULT_PROJECT_ID);
    getSettingsStore().set("desktopNotifications", false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    getSettingsStore().set("desktopNotifications", false);
  });

  it("raises one notification for a new needs-you in another project when opted in and granted", async () => {
    stubNotification("granted");
    getSettingsStore().set("desktopNotifications", true);
    await render(<Effects store={store} />);

    // The first snapshot is what was already waiting: nothing to announce.
    store.setState({ feed: feedOf(project("gamma", "Gamma", "g")), ready: true });
    expect(calls).toHaveLength(0);

    store.setState({ feed: feedOf(project("gamma", "Gamma", "g"), project("beta", "Beta", "b")) });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.title).toContain("Beta");
    expect(calls[0]?.options?.tag).toBe("beta:req-beta-b");

    // The same request arriving again (a new frame, same record) is not announced twice.
    store.setState({ feed: feedOf(project("gamma", "Gamma", "g"), project("beta", "Beta", "b")) });
    expect(calls).toHaveLength(1);
  });

  it("never raises a notification while the setting is off, which is the default", async () => {
    stubNotification("granted");
    expect(getSettingsStore().getSnapshot().desktopNotifications).toBe(false);
    await render(<Effects store={store} />);
    store.setState({ feed: feedOf(), ready: true });
    store.setState({ feed: feedOf(project("beta", "Beta", "b")) });
    expect(calls).toHaveLength(0);
  });

  it("never raises a notification without the browser's permission", async () => {
    stubNotification("denied");
    getSettingsStore().set("desktopNotifications", true);
    await render(<Effects store={store} />);
    store.setState({ feed: feedOf(), ready: true });
    store.setState({ feed: feedOf(project("beta", "Beta", "b")) });
    expect(calls).toHaveLength(0);
  });
});
