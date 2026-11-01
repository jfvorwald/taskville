import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { Attention } from "../../data/domain.ts";
import { createDataStore, type DataStore } from "../../data/store.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { createAnchorSource } from "../host/anchors.ts";
import type { OverlayMode, OverlayProps } from "../host/types.ts";
import { ActionCard, actionCardOverlay } from "./ActionCard.tsx";

// M4.07 (ARCHITECTURE.md 2.4, 3, 9; decisions #116 D4 and #271): the action card, one test group
// per state.
//
// Contract pinned here:
//   <ActionCard {...OverlayProps} store?={DataStore} fetch?={typeof fetch} />
// reads the selected agent from `selection.selectedId`, its needs-you record and request from
// `store` (default: the app store), the waiting time from `store.now()`, and the session secret
// from `useSession()`. Engine calls go through `fetch` (default: global fetch). It renders nothing
// unless the selected agent needs you.
//
// Markers: root `data-testid="action-card"` with
//   data-state    open | sent | answered_elsewhere | expired | closed
//   data-variant  decision | open-only
//   data-readonly "true" in history mode (absent in live mode)
// plus `action-card-input` (the exact input, nothing else inside it but reveal buttons),
// `action-card-cwd`. Buttons are found by role and name: "Allow once", "Deny", "Open session",
// and one button named /reveal/i per masked span; the note is a textbox named /note/i.

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const SINCE = new Date(NOW - 125_000).toISOString(); // waiting 2m 5s
let clock = NOW;

const SECRET_HEADER = "X-Taskville-Session";
const SESSION_SECRET = "secret-1";
const RAW = "SECRET-RAW-TEXT /Users/me/private";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// --- the world --------------------------------------------------------------------------------

const BEARER = "abcdefghijklmnop1234";
const GITHUB = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
const COMMAND = "npm test -- --runInBand";

interface RequestOver {
  [key: string]: unknown;
}

function request(over: RequestOver = {}) {
  return {
    id: "req-1",
    agentId: "a1",
    sessionId: "sess-1",
    kind: "permission",
    toolName: "Bash",
    answerable: true,
    openedAt: SINCE,
    state: "open",
    late: false,
    mergedRequestIds: [],
    ...over,
  };
}

function needsYou(agentId: string, requestId: string): Attention {
  return {
    agentId,
    level: "needs_you",
    kind: "permission",
    since: SINCE,
    requestId,
    heuristic: false,
  };
}

interface World {
  requests?: Record<string, ReturnType<typeof request>>;
  agents?: Record<string, { id: string; displayName?: string }>;
  attention?: Attention[];
  /** The domain `Session` entities, by id: `workingDirectory` is what the session reported. */
  sessions?: Record<string, { id: string; workingDirectory?: string }>;
}

function makeStore(world: World = {}): DataStore {
  const store = createDataStore({ now: () => clock });
  store.setState({
    projectId: "proj-1",
    connection: "live",
    attention: world.attention ?? [needsYou("a1", "req-1")],
    state: {
      agents: world.agents ?? { a1: { id: "a1", displayName: "Ada" } },
      requests: world.requests ?? { "req-1": request() },
      sessions: world.sessions ?? {},
    } as unknown as NonNullable<ReturnType<typeof store.getState>["state"]>,
  });
  return store;
}

/** The engine's other side of `request.resolved` / `request.expired`: the record leaves attention. */
function closeRequest(store: DataStore, id: string, state: string) {
  const current = store.getState().state as unknown as {
    requests: Record<string, Record<string, unknown>>;
  };
  store.setState({
    attention: [],
    state: {
      ...current,
      requests: { ...current.requests, [id]: { ...current.requests[id], state } },
    } as never,
  });
}

// --- the engine -------------------------------------------------------------------------------

interface Call {
  path: string;
  search: string;
  method: string;
  headers: Headers;
  body?: Record<string, unknown>;
}

function held(toolInput: unknown = { command: COMMAND }) {
  return {
    requestId: "req-1",
    projectId: "proj-1",
    sessionId: "sess-1",
    toolName: "Bash",
    toolInput,
    cwd: "/work/app",
  };
}

function createEngine() {
  const calls: Call[] = [];
  const engine = {
    calls,
    input: (): Response | Promise<Response> => json(200, held()),
    command: (body: Record<string, unknown>): Response | Promise<Response> => {
      if (body.type === "session.open") {
        return json(200, {
          command: {
            id: "c-open",
            type: "session.open",
            requestId: body.requestId,
            status: "succeeded",
            result: { outcome: "copy-only", sessionId: "sess-1", cwd: "/work/app" },
          },
        });
      }
      return json(200, {
        command: {
          id: "c-decide",
          type: "permission.decide",
          requestId: body.requestId,
          status: "delivered",
        },
      });
    },
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(url), "http://localhost");
      const body =
        init?.body === undefined
          ? undefined
          : (JSON.parse(String(init.body)) as Record<string, unknown>);
      calls.push({
        path: parsed.pathname,
        search: parsed.search,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        ...(body === undefined ? {} : { body }),
      });
      if (parsed.pathname.startsWith("/v1/requests/")) return engine.input();
      if (parsed.pathname === "/v1/commands" && init?.method === "POST") {
        return engine.command(body ?? {});
      }
      return json(404, { error: { code: "not_found", message: "no route" } });
    }) as typeof fetch,
  };
  return engine;
}

type Engine = ReturnType<typeof createEngine>;
const posts = (engine: Engine) => engine.calls.filter((c) => c.method === "POST");
const gets = (engine: Engine) => engine.calls.filter((c) => c.method === "GET");

const errorResponse = (status: number, code: string) =>
  json(status, { error: { code, message: RAW } });

// --- mounting and finding things --------------------------------------------------------------

function overlayProps(selectedId: string | null, mode: OverlayMode): OverlayProps {
  return {
    mode,
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId, select: () => {} },
    anchors: createAnchorSource(),
    intents: { available: mode === "live", run: () => {} },
    settings: { get: (_k, f) => f, set: () => {} },
  };
}

interface MountOptions {
  store?: DataStore;
  engine?: Engine;
  selectedId?: string | null;
  mode?: OverlayMode;
}

function tree(store: DataStore, engine: Engine, selectedId: string | null, mode: OverlayMode) {
  return (
    <SessionProvider value={SESSION_SECRET}>
      <div style={{ position: "relative", width: 360, height: 640 }}>
        <ActionCard {...overlayProps(selectedId, mode)} store={store} fetch={engine.fetch} />
      </div>
    </SessionProvider>
  );
}

async function mount(options: MountOptions = {}) {
  const store = options.store ?? makeStore();
  const engine = options.engine ?? createEngine();
  const selectedId = options.selectedId === undefined ? "a1" : options.selectedId;
  const mode = options.mode ?? "live";
  const view = await render(tree(store, engine, selectedId, mode));
  return {
    store,
    engine,
    view,
    reselect: (id: string | null) => view.rerender(tree(store, engine, id, mode)),
  };
}

const allow = () => page.getByRole("button", { name: "Allow once", exact: true });
const deny = () => page.getByRole("button", { name: "Deny", exact: true });
const openSession = () => page.getByRole("button", { name: "Open session", exact: true });
const note = () => page.getByRole("textbox", { name: /note/i });
const reveals = () => page.getByRole("button", { name: /reveal/i });

const cardEl = () => document.querySelector<HTMLElement>('[data-testid="action-card"]');
const inputEl = () => document.querySelector<HTMLElement>('[data-testid="action-card-input"]');
const cardText = () => cardEl()?.textContent ?? "";
const stateOf = () => cardEl()?.getAttribute("data-state");

/** The card is up and its exact input has loaded (Allow is enabled or only masks hold it). */
async function loaded() {
  await vi.waitFor(() => expect(inputEl()?.textContent ?? "").not.toBe(""));
}

async function expectAllDisabled() {
  await expect.element(allow()).toBeDisabled();
  await expect.element(deny()).toBeDisabled();
  await expect.element(openSession()).toBeDisabled();
}

function stubClipboard(impl: (text: string) => Promise<void> = async () => {}) {
  const writeText = vi.fn(impl);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

beforeEach(() => {
  clock = NOW;
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

// --- opening ----------------------------------------------------------------------------------

describe("ActionCard: opening (one sidebar slot)", () => {
  it("is a sidebar overlay in both modes, so history can show it read-only", () => {
    expect(actionCardOverlay).toMatchObject({ id: "action-card", slot: "sidebar" });
    expect([...actionCardOverlay.modes].sort()).toEqual(["history", "live"]);
    expect(actionCardOverlay.Component).toBe(ActionCard);
  });

  it("renders nothing, and calls no endpoint, when no agent is selected", async () => {
    const { engine } = await mount({ selectedId: null });
    await new Promise((r) => setTimeout(r, 100));
    expect(cardEl()).toBeNull();
    expect(engine.calls).toHaveLength(0);
  });

  it("renders nothing for a selected agent that does not need you", async () => {
    const store = makeStore({
      agents: { a1: { id: "a1" }, a2: { id: "a2", displayName: "Bo" } },
      attention: [needsYou("a1", "req-1")],
    });
    const { engine } = await mount({ store, selectedId: "a2" });
    await new Promise((r) => setTimeout(r, 100));
    expect(cardEl()).toBeNull();
    expect(engine.calls).toHaveLength(0);
  });

  it("opens for the selected needs-you agent and asks the bridge for its exact input", async () => {
    const { engine } = await mount();
    await loaded();
    expect(cardEl()).not.toBeNull();
    const [call, ...rest] = gets(engine);
    expect(rest).toHaveLength(0);
    expect(call?.path).toBe("/v1/requests/req-1/input");
    expect(call?.search).toBe("?projectId=proj-1");
    expect(call?.headers.get(SECRET_HEADER)).toBe(SESSION_SECRET);
  });

  it("follows the selection: another needs-you agent shows its own request", async () => {
    const store = makeStore({
      agents: { a1: { id: "a1", displayName: "Ada" }, a2: { id: "a2", displayName: "Bo" } },
      requests: {
        "req-1": request(),
        "req-2": request({ id: "req-2", agentId: "a2", sessionId: "sess-2" }),
      },
      attention: [needsYou("a1", "req-1"), needsYou("a2", "req-2")],
    });
    const { engine, reselect } = await mount({ store });
    await loaded();
    expect(cardText()).toContain("Ada");
    await reselect("a2");
    await vi.waitFor(() => expect(cardText()).toContain("Bo"));
    expect(cardText()).not.toContain("Ada");
    await vi.waitFor(() =>
      expect(gets(engine).map((c) => c.path)).toContain("/v1/requests/req-2/input"),
    );
  });

  it("goes away when the selection is cleared, even after a decision was sent", async () => {
    const { reselect } = await mount();
    await loaded();
    await allow().click();
    await vi.waitFor(() => expect(stateOf()).toBe("sent"));
    await reselect(null);
    await vi.waitFor(() => expect(cardEl()).toBeNull());
  });
});

// --- who, what, how long ----------------------------------------------------------------------

describe("ActionCard: header", () => {
  it("shows agent, project, session, tool, working directory and how long it has waited", async () => {
    await mount();
    await loaded();
    const text = cardText();
    expect(text).toContain("Ada");
    expect(text).toContain("proj-1");
    expect(text).toContain("sess-1");
    expect(text).toContain("Bash");
    expect(text).toContain("2m 5s");
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="action-card-cwd"]')?.textContent).toContain(
        "/work/app",
      ),
    );
  });

  it("keeps counting from the store clock without a new event", async () => {
    await mount();
    await loaded();
    expect(cardText()).toContain("2m 5s");
    clock = NOW + 60_000;
    await expect.poll(cardText, { timeout: 4000 }).toContain("3m 5s");
  });

  it("falls back to the agent id when the agent has no display name", async () => {
    const store = makeStore({ agents: { a1: { id: "a1" } } });
    await mount({ store });
    await loaded();
    expect(cardText()).toContain("a1");
  });
});

// --- exact input ------------------------------------------------------------------------------

describe("ActionCard: exact input", () => {
  it("shows a 20,000-character input in full, monospace, in a scroll area", async () => {
    let text = "";
    for (let i = 0; text.length < 20_000; i++) text += `echo step ${i} alpha beta gamma\n`;
    const engine = createEngine();
    engine.input = () => json(200, held(text));
    await mount({ engine });
    await vi.waitFor(() => expect(inputEl()?.textContent).toBe(text));
    const el = inputEl() as HTMLElement;
    const style = getComputedStyle(el);
    expect(style.fontFamily).toMatch(/mono/i);
    expect(["auto", "scroll"]).toContain(style.overflowY);
    expect(el.scrollHeight).toBeGreaterThan(el.clientHeight);
  });

  it("shows a Bash command as the command itself", async () => {
    const engine = createEngine();
    engine.input = () => json(200, held({ command: "set -e\nmake all" }));
    await mount({ engine });
    await vi.waitFor(() => expect(inputEl()?.textContent).toBe("set -e\nmake all"));
  });

  it("renders markup in the input, tool name and names as text and creates no elements", async () => {
    const markup = "<img src=x onerror=alert(1)><b>bold</b><script>window.__pwned=1</script>";
    const engine = createEngine();
    engine.input = () => json(200, { ...held(markup), toolName: "<u>Bash</u>" });
    const store = makeStore({
      agents: { a1: { id: "a1", displayName: "<i>Ada</i>" } },
      requests: { "req-1": request({ toolName: "<u>Bash</u>" }) },
    });
    await mount({ engine, store });
    await vi.waitFor(() => expect(inputEl()?.textContent).toBe(markup));
    expect(cardText()).toContain("<i>Ada</i>");
    expect(cardEl()?.querySelectorAll("img, b, i, u, script, iframe").length).toBe(0);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("keeps Allow disabled while the input is still loading, but never gates Deny", async () => {
    const pending = deferred<Response>();
    const engine = createEngine();
    engine.input = () => pending.promise;
    await mount({ engine });
    await expect.element(allow()).toBeDisabled();
    await expect.element(deny()).toBeEnabled();
    await expect.element(openSession()).toBeEnabled();
    pending.resolve(json(200, held()));
    await expect.element(allow()).toBeEnabled();
  });

  it("says so, and keeps Allow disabled, when the input cannot be loaded", async () => {
    const engine = createEngine();
    engine.input = () => errorResponse(500, "internal");
    await mount({ engine });
    await vi.waitFor(() => expect(cardText()).toMatch(/could not load/i));
    expect(cardText()).not.toContain(RAW);
    await expect.element(allow()).toBeDisabled();
    await expect.element(deny()).toBeEnabled();
    expect(stateOf()).toBe("open");
  });
});

// --- masking ----------------------------------------------------------------------------------

describe("ActionCard: masked secrets", () => {
  const secretInput = `curl -H "Authorization: Bearer ${BEARER}" https://api.example.com && export GH=${GITHUB}`;

  async function mountWithSecrets() {
    const engine = createEngine();
    engine.input = () => json(200, held(secretInput));
    const mounted = await mount({ engine });
    await vi.waitFor(() => expect(inputEl()?.textContent ?? "").toContain("curl"));
    return mounted;
  }

  it("hides every secret-looking span: not in the text and not anywhere in the markup", async () => {
    await mountWithSecrets();
    expect(inputEl()?.textContent).not.toContain(BEARER);
    expect(inputEl()?.textContent).not.toContain(GITHUB);
    expect(cardEl()?.innerHTML).not.toContain(BEARER);
    expect(cardEl()?.innerHTML).not.toContain(GITHUB);
    expect(inputEl()?.textContent).toContain("https://api.example.com");
    expect(reveals().elements()).toHaveLength(2);
  });

  it("keeps Allow disabled until every masked span is revealed", async () => {
    await mountWithSecrets();
    await expect.element(allow()).toBeDisabled();

    await reveals().first().click();
    expect(inputEl()?.textContent).toContain(BEARER);
    expect(inputEl()?.textContent).not.toContain(GITHUB);
    expect(reveals().elements()).toHaveLength(1);
    await expect.element(allow()).toBeDisabled();

    await reveals().first().click();
    expect(inputEl()?.textContent).toContain(GITHUB);
    expect(reveals().elements()).toHaveLength(0);
    await expect.element(allow()).toBeEnabled();
  });

  it("sends nothing when a disabled Allow is clicked", async () => {
    const { engine } = await mountWithSecrets();
    const allowEl = allow().element() as HTMLButtonElement;
    expect(allowEl.disabled).toBe(true);
    allowEl.click();
    await new Promise((r) => setTimeout(r, 100));
    expect(posts(engine)).toHaveLength(0);
  });

  it("never gates Deny or Open session on the masks", async () => {
    const { engine } = await mountWithSecrets();
    await expect.element(deny()).toBeEnabled();
    await expect.element(openSession()).toBeEnabled();
    await deny().click();
    await vi.waitFor(() => expect(posts(engine)).toHaveLength(1));
    expect(posts(engine)[0]?.body?.decision).toStrictEqual({ behavior: "deny" });
  });

  it("enables Allow at once when the input has nothing to mask", async () => {
    await mount();
    await loaded();
    expect(reveals().elements()).toHaveLength(0);
    await expect.element(allow()).toBeEnabled();
  });
});

// --- structured inputs: values sealed whole (M4.07 pin round) ---------------------------------
//
// A structured input is shown as pretty JSON. A value the engine's JSON redactor would seal whole
// (an object, array or number under a sensitive key, or the `value` of a separated name/value
// pair) is one masked span: its text is nowhere in the card until revealed, and Allow stays off
// until every mask is revealed. The text of each secret below is checked against the card's whole
// markup, not only the input box.

describe("ActionCard: masked values sealed whole", () => {
  const cases: Array<{
    name: string;
    toolInput: unknown;
    /** Fragments that must not appear in the markup while masked. */
    hidden: string[];
    /** What the input box holds once the single mask is revealed. */
    shownAfterReveal: string;
  }> = [
    {
      name: "a nested object under a sensitive key",
      toolInput: { tool: "deploy", password: { value: "hunter2-nested", extra: "zz-inner-key" } },
      hidden: ["hunter2-nested", "zz-inner-key"],
      shownAfterReveal: "hunter2-nested",
    },
    {
      name: "an array under a sensitive key",
      toolInput: { tool: "deploy", apiToken: ["alpha-secret-one", "beta-secret-two"] },
      hidden: ["alpha-secret-one", "beta-secret-two"],
      shownAfterReveal: "beta-secret-two",
    },
    {
      name: "a number under a sensitive key",
      toolInput: { tool: "deploy", token: 918273645 },
      hidden: ["918273645"],
      shownAfterReveal: "918273645",
    },
    {
      name: "a separated name/value pair",
      toolInput: { tool: "deploy", name: "DB_PASSWORD", other: true, value: "hunter2" },
      hidden: ["hunter2"],
      shownAfterReveal: "hunter2",
    },
    {
      name: "a string with JSON escapes (quote, backslash, newline, \\u0001)",
      toolInput: {
        'we"ird': "x",
        name: "DB_PASSWORD",
        other: true,
        value: 'pa"ss\\w\nord\u0001end',
      },
      hidden: ["ss\\\\w", "ord\\u0001end", "u0001"],
      shownAfterReveal: 'pa\\"ss\\\\w\\nord\\u0001end',
    },
  ];

  it.each(cases)("$name: hidden until revealed, Allow off until then", async (c) => {
    const engine = createEngine();
    engine.input = () => json(200, held(c.toolInput));
    await mount({ engine });
    await loaded();
    await expect.poll(() => reveals().elements().length).toBe(1);

    for (const fragment of c.hidden) {
      expect(inputEl()?.textContent).not.toContain(fragment);
      expect(cardEl()?.innerHTML).not.toContain(fragment);
    }
    await expect.element(allow()).toBeDisabled();

    await reveals().first().click();
    expect(inputEl()?.textContent).toContain(c.shownAfterReveal);
    expect(reveals().elements()).toHaveLength(0);
    await expect.element(allow()).toBeEnabled();
  });

  it("keeps Allow off until a sealed value and a text-pass secret are both revealed", async () => {
    const engine = createEngine();
    engine.input = () => json(200, held({ password: { v: "hunter2-nested" }, env: `A=${GITHUB}` }));
    await mount({ engine });
    await expect.poll(() => reveals().elements().length).toBe(2);
    expect(cardEl()?.innerHTML).not.toContain("hunter2-nested");
    expect(cardEl()?.innerHTML).not.toContain(GITHUB);
    await reveals().first().click();
    await expect.element(allow()).toBeDisabled();
    await reveals().first().click();
    await expect.element(allow()).toBeEnabled();
  });
});

// --- working directory: the session's, when the exact input has none -------------------------
//
// Observe-only (CTO decision): when the exact-input route omits `cwd`, the card shows the
// `workingDirectory` the store recorded for the request's session (`state.sessions[sessionId]`);
// when there is none either, `action-card-cwd` holds a neutral "unknown" label. A path is never
// made up, and one session's directory is never shown for another's request.

describe("ActionCard: working directory fallback", () => {
  const withoutCwd = () => {
    const engine = createEngine();
    engine.input = () => json(200, { ...held(), cwd: undefined });
    return engine;
  };
  const cwdText = () =>
    document.querySelector('[data-testid="action-card-cwd"]')?.textContent ?? "";

  it("shows the session's recorded working directory when the exact input omits cwd", async () => {
    const store = makeStore({
      sessions: { "sess-1": { id: "sess-1", workingDirectory: "/work/from-session" } },
    });
    await mount({ engine: withoutCwd(), store });
    await loaded();
    await vi.waitFor(() => expect(cwdText()).toContain("/work/from-session"));
  });

  it("prefers the exact input's cwd over the session's", async () => {
    const store = makeStore({
      sessions: { "sess-1": { id: "sess-1", workingDirectory: "/work/from-session" } },
    });
    await mount({ store });
    await loaded();
    await vi.waitFor(() => expect(cwdText()).toContain("/work/app"));
    expect(cwdText()).not.toContain("/work/from-session");
  });

  it("shows a neutral unknown label, and no path, when neither source has one", async () => {
    await mount({ engine: withoutCwd() });
    await loaded();
    await vi.waitFor(() => expect(cwdText()).toMatch(/unknown/i));
    expect(cwdText()).not.toContain("/");
  });

  it("does not borrow another session's working directory", async () => {
    const store = makeStore({
      sessions: { "sess-2": { id: "sess-2", workingDirectory: "/work/other" } },
    });
    await mount({ engine: withoutCwd(), store });
    await loaded();
    await vi.waitFor(() => expect(cwdText()).toMatch(/unknown/i));
    expect(cardText()).not.toContain("/work/other");
  });
});

// --- buttons ----------------------------------------------------------------------------------

describe("ActionCard: Allow once, Deny, Open session", () => {
  it("offers exactly those three actions and no always-allow (ARCHITECTURE 2.4, 13)", async () => {
    await mount();
    await loaded();
    const names = Array.from(cardEl()?.querySelectorAll("button") ?? []).map((b) =>
      (b.textContent ?? "").trim(),
    );
    expect(names.sort()).toEqual(["Allow once", "Deny", "Open session"]);
    expect(cardText()).not.toMatch(/always|remember|don't ask|do not ask|bulk/i);
  });

  it("Allow once sends one permission.decide with the contract's exact body", async () => {
    const { engine } = await mount();
    await loaded();
    await allow().click();
    await vi.waitFor(() => expect(posts(engine)).toHaveLength(1));
    const post = posts(engine)[0] as Call;
    expect(post.path).toBe("/v1/commands");
    expect(post.headers.get(SECRET_HEADER)).toBe(SESSION_SECRET);
    expect(post.body).toStrictEqual({
      type: "permission.decide",
      projectId: "proj-1",
      requestId: "req-1",
      idempotencyKey: expect.stringMatching(/\S{8,}/),
      decision: { behavior: "allow" },
    });
  });

  it("uses a fresh idempotency key for each click", async () => {
    const engine = createEngine();
    engine.command = () => errorResponse(500, "internal"); // leaves the buttons usable
    await mount({ engine });
    await loaded();
    await allow().click();
    await vi.waitFor(() => expect(posts(engine)).toHaveLength(1));
    await expect.element(allow()).toBeEnabled();
    await allow().click();
    await vi.waitFor(() => expect(posts(engine)).toHaveLength(2));
    const [first, second] = posts(engine).map((p) => p.body?.idempotencyKey);
    expect(first).toEqual(expect.any(String));
    expect(second).toEqual(expect.any(String));
    expect(first).not.toBe(second);
  });

  it("a double click sends one request: the buttons lock while a command is in flight", async () => {
    const pending = deferred<Response>();
    const engine = createEngine();
    engine.command = () => pending.promise;
    await mount({ engine });
    await loaded();
    await allow().dblClick();
    await vi.waitFor(() => expect(posts(engine)).toHaveLength(1));
    await expectAllDisabled();
    pending.resolve(
      json(200, { command: { id: "c1", type: "permission.decide", status: "delivered" } }),
    );
    await vi.waitFor(() => expect(stateOf()).toBe("sent"));
    expect(posts(engine)).toHaveLength(1);
  });

  it("Deny without a note sends no message", async () => {
    const { engine } = await mount();
    await loaded();
    await deny().click();
    await vi.waitFor(() => expect(posts(engine)).toHaveLength(1));
    expect(posts(engine)[0]?.body).toStrictEqual({
      type: "permission.decide",
      projectId: "proj-1",
      requestId: "req-1",
      idempotencyKey: expect.any(String),
      decision: { behavior: "deny" },
    });
  });

  it("Deny sends the optional note to the agent as `message`", async () => {
    const { engine } = await mount();
    await loaded();
    await note().fill("use the dry run flag first");
    await deny().click();
    await vi.waitFor(() => expect(posts(engine)).toHaveLength(1));
    expect(posts(engine)[0]?.body?.decision).toStrictEqual({
      behavior: "deny",
      message: "use the dry run flag first",
    });
  });

  it("Allow ignores a typed note", async () => {
    const { engine } = await mount();
    await loaded();
    await note().fill("use the dry run flag first");
    await allow().click();
    await vi.waitFor(() => expect(posts(engine)).toHaveLength(1));
    expect(posts(engine)[0]?.body?.decision).toStrictEqual({ behavior: "allow" });
  });

  it("Open session sends session.open for the request's session", async () => {
    const { engine } = await mount();
    await loaded();
    await openSession().click();
    await vi.waitFor(() => expect(posts(engine)).toHaveLength(1));
    expect(posts(engine)[0]?.body).toStrictEqual({
      type: "session.open",
      projectId: "proj-1",
      requestId: "req-1",
      sessionId: "sess-1",
      idempotencyKey: expect.any(String),
    });
  });

  it("copy-only: copies the session id and working directory, and says so", async () => {
    const writeText = stubClipboard();
    await mount();
    await loaded();
    await openSession().click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0]?.[0] ?? "";
    expect(copied).toContain("sess-1");
    expect(copied).toContain("/work/app");
    await vi.waitFor(() => expect(cardText()).toMatch(/copied/i));
    // Opening a session does not answer the prompt: the decision stays open.
    expect(stateOf()).toBe("open");
    await expect.element(allow()).toBeEnabled();
  });

  it("opened: says the session was opened", async () => {
    const engine = createEngine();
    engine.command = (body) =>
      json(200, {
        command: {
          id: "c-open",
          type: "session.open",
          requestId: body.requestId,
          status: "succeeded",
          result: { outcome: "opened", sessionId: "sess-1", cwd: "/work/app" },
        },
      });
    await mount({ engine });
    await loaded();
    await openSession().click();
    await vi.waitFor(() => expect(cardText()).toMatch(/opened/i));
    expect(stateOf()).toBe("open");
  });

  it("copy-only with a blocked clipboard says it could not copy and shows the values to copy by hand", async () => {
    stubClipboard(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    await mount();
    await loaded();
    await openSession().click();
    await vi.waitFor(() => expect(cardText()).toMatch(/could not copy/i));
    expect(cardText()).toContain("sess-1");
    expect(cardText()).toContain("/work/app");
  });
});

// --- results and errors -----------------------------------------------------------------------

describe("ActionCard: after a decision", () => {
  it.each([
    ["Allow once", allow],
    ["Deny", deny],
  ])(
    "%s ends as 'Sent, unconfirmed', never as allowed, approved or denied (#116 D4)",
    async (_n, button) => {
      await mount();
      await loaded();
      await button().click();
      await vi.waitFor(() => expect(stateOf()).toBe("sent"));
      expect(cardText()).toMatch(/sent, unconfirmed/i);
      expect(cardText()).not.toMatch(/\b(allowed|approved|denied|granted|rejected)\b/i);
      await expectAllDisabled();
    },
  );

  it("keeps 'Sent, unconfirmed' when the request leaves attention and is recorded as answered here", async () => {
    const { store } = await mount();
    await loaded();
    await allow().click();
    await vi.waitFor(() => expect(stateOf()).toBe("sent"));
    closeRequest(store, "req-1", "answered_here");
    await new Promise((r) => setTimeout(r, 150));
    expect(cardEl()).not.toBeNull();
    expect(stateOf()).toBe("sent");
    expect(cardText()).toMatch(/sent, unconfirmed/i);
    await expectAllDisabled();
  });
});

describe("ActionCard: states", () => {
  it("answered elsewhere: says it was answered in the terminal and disables every button", async () => {
    const { store } = await mount();
    await loaded();
    closeRequest(store, "req-1", "answered_elsewhere");
    await vi.waitFor(() => expect(stateOf()).toBe("answered_elsewhere"));
    expect(cardText()).toMatch(/answered in the terminal/i);
    await expectAllDisabled();
  });

  it("expired by an event: says expired and disables every button", async () => {
    const { store } = await mount();
    await loaded();
    closeRequest(store, "req-1", "expired");
    await vi.waitFor(() => expect(stateOf()).toBe("expired"));
    expect(cardText()).toMatch(/expired/i);
    await expectAllDisabled();
  });

  it("expired at open (410 on the exact input): the bridge no longer holds it", async () => {
    const engine = createEngine();
    engine.input = () => errorResponse(410, "request_expired");
    await mount({ engine });
    await vi.waitFor(() => expect(stateOf()).toBe("expired"));
    expect(cardText()).toMatch(/expired/i);
    expect(cardText()).toMatch(/terminal/i);
    expect(cardText()).not.toContain(RAW);
    await expectAllDisabled();
  });

  it("expired when sending (410 request_expired): says expired, disables every button", async () => {
    const engine = createEngine();
    engine.command = () => errorResponse(410, "request_expired");
    await mount({ engine });
    await loaded();
    await allow().click();
    await vi.waitFor(() => expect(stateOf()).toBe("expired"));
    expect(cardText()).toMatch(/expired/i);
    expect(cardText()).not.toMatch(/sent, unconfirmed/i);
    await expectAllDisabled();
  });

  it("request_not_open: says it is no longer open and disables every button", async () => {
    const engine = createEngine();
    engine.command = () => errorResponse(409, "request_not_open");
    await mount({ engine });
    await loaded();
    await deny().click();
    await vi.waitFor(() => expect(stateOf()).toBe("closed"));
    expect(cardText()).toMatch(/no longer open|already/i);
    await expectAllDisabled();
  });

  it("not_answerable: becomes the open-session-only card", async () => {
    const engine = createEngine();
    engine.command = () => errorResponse(422, "not_answerable");
    await mount({ engine });
    await loaded();
    await allow().click();
    await vi.waitFor(() => expect(cardEl()?.getAttribute("data-variant")).toBe("open-only"));
    await expect.element(allow()).not.toBeInTheDocument();
    await expect.element(deny()).not.toBeInTheDocument();
    await expect.element(openSession()).toBeEnabled();
  });

  it.each([
    ["command_in_flight", 409, /already running|in progress/i, openSession],
    ["opener_failed", 502, /could not open/i, openSession],
    ["idempotency_conflict", 409, /./, allow],
    ["bad_request", 400, /./, allow],
  ])(
    "%s shows a short message, never the server's text, and the card stays usable",
    async (code, status, pattern, button) => {
      const engine = createEngine();
      engine.command = () => errorResponse(status, code);
      await mount({ engine });
      await loaded();
      await button().click();
      await vi.waitFor(() => expect(cardText()).toMatch(pattern));
      expect(cardText()).not.toContain(RAW);
      expect(cardText()).not.toContain(code);
      expect(stateOf()).toBe("open");
      await expect.element(deny()).toBeEnabled();
    },
  );

  it("a network failure says to try again, keeps the card open, and re-enables the buttons", async () => {
    const engine = createEngine();
    engine.command = () => {
      throw new TypeError(RAW);
    };
    await mount({ engine });
    await loaded();
    await allow().click();
    await vi.waitFor(() => expect(cardText()).toMatch(/try again/i));
    expect(cardText()).not.toContain(RAW);
    expect(stateOf()).toBe("open");
    await expect.element(allow()).toBeEnabled();
  });
});

// --- open-session-only variant ----------------------------------------------------------------

describe("ActionCard: open-session-only variant (not held by the bridge)", () => {
  const telemetryOnly = () =>
    makeStore({
      requests: {
        "req-1": request({
          kind: "input",
          answerable: false,
          toolName: undefined,
          reason: { text: "Claude needs your input", masked: false, truncated: false },
        }),
      },
      attention: [{ ...needsYou("a1", "req-1"), kind: "input" }],
    });

  it("shows the reason and Open session only, and never asks the bridge for an input", async () => {
    const { engine } = await mount({ store: telemetryOnly() });
    await vi.waitFor(() => expect(cardEl()?.getAttribute("data-variant")).toBe("open-only"));
    expect(cardText()).toContain("Claude needs your input");
    expect(cardText()).toContain("Ada");
    await expect.element(openSession()).toBeEnabled();
    await expect.element(allow()).not.toBeInTheDocument();
    await expect.element(deny()).not.toBeInTheDocument();
    await expect.element(note()).not.toBeInTheDocument();
    expect(reveals().elements()).toHaveLength(0);
    expect(inputEl()).toBeNull();
    expect(engine.calls).toHaveLength(0);
  });

  it("Open session still sends session.open and copies the session", async () => {
    const writeText = stubClipboard();
    const { engine } = await mount({ store: telemetryOnly() });
    await openSession().click();
    await vi.waitFor(() => expect(posts(engine)).toHaveLength(1));
    expect(posts(engine)[0]?.body).toMatchObject({
      type: "session.open",
      requestId: "req-1",
      sessionId: "sess-1",
    });
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  });

  it("renders the agent-supplied reason as text", async () => {
    const store = makeStore({
      requests: {
        "req-1": request({
          kind: "input",
          answerable: false,
          reason: {
            text: "<b>Choose</b> <img src=x onerror=alert(1)>",
            masked: false,
            truncated: false,
          },
        }),
      },
      attention: [{ ...needsYou("a1", "req-1"), kind: "input" }],
    });
    await mount({ store });
    await vi.waitFor(() => expect(cardText()).toContain("<b>Choose</b>"));
    expect(cardEl()?.querySelectorAll("b, img").length).toBe(0);
  });

  it("the open-only card goes read-only too once its request is answered elsewhere", async () => {
    const { store } = await mount({ store: telemetryOnly() });
    await vi.waitFor(() => expect(cardEl()).not.toBeNull());
    closeRequest(store, "req-1", "answered_elsewhere");
    await vi.waitFor(() => expect(stateOf()).toBe("answered_elsewhere"));
    await expect.element(openSession()).toBeDisabled();
  });
});

// --- history ----------------------------------------------------------------------------------

describe("ActionCard: history mode is read-only (ARCHITECTURE 3)", () => {
  it("shows who and what, marks itself read-only, and has no action buttons or note box", async () => {
    const store = makeStore({
      requests: { "req-1": request({ inputPreview: "npm test -- --runInBand" }) },
    });
    await mount({ store, mode: "history" });
    await vi.waitFor(() => expect(cardEl()).not.toBeNull());
    expect(cardEl()?.getAttribute("data-readonly")).toBe("true");
    expect(cardText()).toContain("Ada");
    expect(cardText()).toContain("Bash");
    await expect.element(allow()).not.toBeInTheDocument();
    await expect.element(deny()).not.toBeInTheDocument();
    await expect.element(openSession()).not.toBeInTheDocument();
    await expect.element(note()).not.toBeInTheDocument();
    expect(cardEl()?.querySelectorAll("button").length).toBe(0);
  });

  it("shows the recorded (redacted) input preview and never calls the engine", async () => {
    const store = makeStore({
      requests: { "req-1": request({ inputPreview: "npm test -- --runInBand" }) },
    });
    const { engine } = await mount({ store, mode: "history" });
    await vi.waitFor(() => expect(inputEl()?.textContent).toBe("npm test -- --runInBand"));
    await new Promise((r) => setTimeout(r, 100));
    expect(engine.calls).toHaveLength(0);
  });

  it("live mode is not marked read-only", async () => {
    await mount();
    await loaded();
    expect(cardEl()?.hasAttribute("data-readonly")).toBe(false);
  });
});
