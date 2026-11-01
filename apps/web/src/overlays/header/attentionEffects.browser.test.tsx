import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { getSettingsStore } from "../settings/store.ts";
import type { AttentionFeed } from "./attention.ts";
import { useAttentionTabTitle, useDesktopNotifications } from "./attentionEffects.ts";
import { type AttentionStore, createAttentionStore, startAttentionSync } from "./attentionSync.ts";

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

describe("tab title on unmount", () => {
  afterEach(() => {
    document.title = "";
  });

  it("goes back to plain Taskville when the effect unmounts, instead of keeping the last count (S4)", async () => {
    const store = createAttentionStore();
    const screen = await render(<Effects store={store} />);
    store.setState({ feed: feedOf(project("beta", "Beta", "b", "c")), ready: true });
    await vi.waitFor(() => expect(document.title).toBe("(2) Taskville"));

    await screen.unmount();
    expect(document.title).toBe("Taskville");
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

  it("shows the project name and agent ID cut to 60 characters with control and bidi characters removed (security L2)", async () => {
    stubNotification("granted");
    getSettingsStore().set("desktopNotifications", true);
    await render(<Effects store={store} />);
    store.setState({ feed: feedOf(), ready: true });

    // Stripping comes first, so the 60 characters kept are all visible ones.
    const name = `\u0000\u0007x‮y⁦z\u007F${"n".repeat(80)}`;
    const agentId = `‮a\u0001${"b".repeat(80)}⁩`;
    store.setState({
      feed: feedOf({ projectId: "evil", name, attention: [record(agentId, "req-evil")] }),
    });

    expect(calls).toHaveLength(1);
    const forbidden = (text: string) =>
      [...text].some((ch) => {
        const c = ch.codePointAt(0) ?? 0;
        return (
          c <= 0x1f || c === 0x7f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)
        );
      });
    const title = calls[0]?.title ?? "";
    const body = calls[0]?.options?.body ?? "";
    expect(title).toBe(`xyz${"n".repeat(57)} needs you`);
    expect(forbidden(title)).toBe(false);
    expect(forbidden(body)).toBe(false);
    expect(body).toContain(`a${"b".repeat(59)}`);
    expect(body).not.toContain("b".repeat(60));
  });

  it("leaves an ordinary project name and agent ID as they are", async () => {
    stubNotification("granted");
    getSettingsStore().set("desktopNotifications", true);
    await render(<Effects store={store} />);
    store.setState({ feed: feedOf(), ready: true });
    store.setState({ feed: feedOf(project("beta", "Beta app", "agent-7")) });
    expect(calls[0]?.title).toBe("Beta app needs you");
    expect(calls[0]?.options?.body).toContain("agent-7");
  });
});

describe("desktop notifications across a reconnect", () => {
  const tags: string[] = [];
  const encoder = new TextEncoder();

  beforeEach(() => {
    tags.length = 0;
    selectProject(DEFAULT_PROJECT_ID);
    getSettingsStore().set("desktopNotifications", true);
    class FakeNotification {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(_title: string, options?: NotificationOptions) {
        tags.push(options?.tag ?? "");
      }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    getSettingsStore().set("desktopNotifications", false);
  });

  const snapshotChunk = (...projects: ReturnType<typeof project>[]) =>
    encoder.encode(`event: snapshot\ndata: ${JSON.stringify({ projects, computedAt: T })}\n\n`);

  it("does not announce a request it already knew, and announces a new one (S5)", async () => {
    // Three connections: the first learns beta's request, the second re-sends the same one, the
    // third adds gamma's. The feed has no resume, so each starts with a snapshot.
    const scripts: ((c: ReadableStreamDefaultController<Uint8Array>) => void)[] = [
      (c) => {
        c.enqueue(snapshotChunk(project("beta", "Beta", "b")));
        c.close();
      },
      (c) => {
        c.enqueue(snapshotChunk(project("beta", "Beta", "b")));
        c.close();
      },
      (c) => {
        c.enqueue(snapshotChunk(project("beta", "Beta", "b"), project("gamma", "Gamma", "g")));
      },
    ];
    let opened = 0;
    const fetchImpl: typeof fetch = async () => {
      const script = scripts[Math.min(opened, scripts.length - 1)];
      opened += 1;
      return new Response(new ReadableStream<Uint8Array>({ start: (c) => script?.(c) }), {
        status: 200,
      });
    };
    const store = createAttentionStore();
    await render(<Effects store={store} />);
    const sync = startAttentionSync({
      store,
      secret: "s",
      fetch: fetchImpl,
      sleep: () => new Promise((r) => setTimeout(r, 5)),
    });

    await vi.waitFor(() => expect("gamma" in store.getState().feed).toBe(true));
    await sync.stop();
    expect(opened).toBe(3);
    // Beta's request was in the first snapshot (nothing to announce) and again in the second (not
    // new). Gamma's arrived on the third: exactly one notification, for it.
    expect(tags).toEqual(["gamma:req-gamma-g"]);
  });
});
