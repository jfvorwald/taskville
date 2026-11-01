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
/** How long a test waits for Allow: the exact input renders, then Allow settles for ~500 ms. */
const SETTLE = 4000;

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
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
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
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
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
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
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
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
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
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
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
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
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
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
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

  it("a recorded `expired` outranks everything: says expired, disables every button", async () => {
    const engine = createEngine();
    engine.input = () => errorResponse(410, "request_expired");
    const store = makeStore({ requests: { "req-1": request({ state: "expired" }) } });
    await mount({ engine, store });
    await vi.waitFor(() => expect(stateOf()).toBe("expired"));
    expect(cardText()).toMatch(/expired/i);
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
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
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

// =================================================================================================
// M4.07 review-fix round (security review BLOCKED on H1, code review BLOCKED on coverage)
//
// Names and behaviour the implementer must provide, beyond what the tests above already pin:
//   - `fetchExactInput({ ..., signal? })` passes `signal` to fetch; the card aborts it on unmount
//     and when the selection moves to another request.
//   - Timeouts use `setTimeout` (not `AbortSignal.timeout`): a wait of 5 to 15 s per engine call.
//   - A persistent `role="status"` element, the first one inside the card, exists from the start.
//   - `visibleControls(text)` in format.ts (see test/overlays/action-card/format.test.ts).
// =================================================================================================

const STRIPE = "sk_live_abcdefghijklmnop1234";
const SLACK = "xoxb-1234567890-abcdefghij";

/** Click reveal buttons one at a time until none remain. */
async function revealAll() {
  for (let i = 0; i < 20 && reveals().elements().length > 0; i++) {
    await reveals().first().click();
  }
}

/** Texts of the enabled buttons in the card. */
const enabledButtons = () =>
  Array.from(cardEl()?.querySelectorAll("button:not(:disabled)") ?? []).map((b) =>
    (b.textContent ?? "").trim(),
  );

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The characters of `text` that hide or reorder what is read: C0 and C1 controls (but not tab and
 * newline), bidi formatting, zero-width characters and the byte order mark.
 */
function hiddenChars(text: string): string[] {
  return Array.from(text).filter((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return (
      (c <= 0x1f && c !== 0x09 && c !== 0x0a) ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x202a && c <= 0x202e) ||
      c === 0x2060 ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0x061c ||
      c === 0xfeff
    );
  });
}

function twoAgents() {
  return makeStore({
    agents: { a1: { id: "a1", displayName: "Ada" }, a2: { id: "a2", displayName: "Bo" } },
    requests: {
      "req-1": request(),
      "req-2": request({ id: "req-2", agentId: "a2", sessionId: "sess-2" }),
    },
    attention: [needsYou("a1", "req-1"), needsYou("a2", "req-2")],
  });
}

/** An engine whose exact-input route answers per request id. */
function routedEngine(inputs: Record<string, unknown>) {
  const engine = createEngine();
  engine.input = () => {
    const id = (engine.calls[engine.calls.length - 1]?.path ?? "").split("/")[3] ?? "";
    return json(200, { ...held(inputs[id]), requestId: id });
  };
  return engine;
}

/** A request that never answers, until its signal aborts it. */
function hang(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("aborted", "AbortError")),
    );
  });
}

function hangOn(engine: Engine, match: (url: string, init?: RequestInit) => boolean) {
  const base = engine.fetch;
  engine.fetch = ((url: RequestInfo | URL, init?: RequestInit) =>
    match(String(url), init) ? hang(init) : base(url, init)) as typeof fetch;
}

/** The signals the card passes with its GETs of the exact input. */
function trackSignals(engine: Engine) {
  const signals: AbortSignal[] = [];
  const base = engine.fetch;
  engine.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).startsWith("/v1/requests/") && init?.signal) signals.push(init.signal);
    return base(url, init);
  }) as typeof fetch;
  return signals;
}

/**
 * Takes over `setTimeout` for waits of 5 to 30 s (the fetch timeout is 10 s) so a test can end
 * them at once. Shorter waits (the 500 ms settle, polling) run for real.
 */
function holdLongTimers() {
  const realSet = window.setTimeout.bind(window);
  const realClear = window.clearTimeout.bind(window);
  const pending = new Map<number, () => void>();
  const delays: number[] = [];
  let next = -1;
  const set = vi.spyOn(window, "setTimeout").mockImplementation(((
    fn: TimerHandler,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (typeof fn === "function" && typeof ms === "number" && ms >= 5000 && ms <= 30_000) {
      const id = next--;
      delays.push(ms);
      pending.set(id, () => fn(...args));
      return id;
    }
    return realSet(fn, ms, ...args);
  }) as unknown as typeof setTimeout);
  const clear = vi.spyOn(window, "clearTimeout").mockImplementation(((id?: number) => {
    if (id !== undefined && pending.has(id)) pending.delete(id);
    else realClear(id);
  }) as typeof clearTimeout);
  return {
    count: () => pending.size,
    delays,
    fire: () => {
      for (const run of [...pending.values()]) run();
      pending.clear();
    },
    restore: () => {
      set.mockRestore();
      clear.mockRestore();
    },
  };
}

// --- H1: secrets in multi-line strings of a pretty-JSON input ---------------------------------
//
// A structured input is shown as pretty JSON, where a newline in a string is the two characters
// backslash and n. The text redactor read that escaped text and missed secrets that sit after a
// newline. Whatever `redactJson` finds in the raw value must be masked in the card (the whole
// displayed string may be masked: fail closed), absent from the markup until revealed, and Allow
// stays off until revealed.

describe("ActionCard: secrets in multi-line strings of a structured input (H1)", () => {
  const cases: Array<{ name: string; toolInput: unknown; hidden: string[] }> = [
    {
      name: "a written .env file with a sensitive assignment and a provider key",
      toolInput: {
        file_path: ".env",
        content: `A=1\nDB_PASSWORD=hunter2x9\nSTRIPE=${STRIPE}`,
      },
      hidden: ["hunter2x9", STRIPE],
    },
    {
      name: "a Bash heredoc with a description",
      toolInput: {
        command: `cat > .env <<'EOF'\nA=1\nDB_PASSWORD=hunter2x9\nSTRIPE=${STRIPE}\nEOF`,
        description: "write the env file",
      },
      hidden: ["hunter2x9", STRIPE],
    },
    {
      name: "a provider key alone on its own line",
      toolInput: { file_path: ".env", content: `A=1\n${STRIPE}\nB=2` },
      hidden: [STRIPE],
    },
    {
      name: "an indented, quoted assignment",
      toolInput: { file_path: ".env", content: `A=1\n\tDB_PASSWORD="hunter2x9"\nB=2` },
      hidden: ["hunter2x9"],
    },
    {
      name: "a PEM private key",
      toolInput: {
        file_path: "k.pem",
        content:
          "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nabcdEFGH1234\n-----END PRIVATE KEY-----",
      },
      hidden: ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"],
    },
  ];

  it.each(cases)("$name: masked, absent from the markup, Allow off until revealed", async (c) => {
    const engine = createEngine();
    engine.input = () => json(200, held(c.toolInput));
    await mount({ engine });
    await loaded();
    await expect.poll(() => reveals().elements().length).toBeGreaterThan(0);
    for (const fragment of c.hidden) {
      expect(inputEl()?.textContent).not.toContain(fragment);
      expect(cardEl()?.innerHTML).not.toContain(fragment);
    }
    await sleep(700);
    await expect.element(allow()).toBeDisabled();

    await revealAll();
    for (const fragment of c.hidden) expect(inputEl()?.textContent).toContain(fragment);
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
  });
});

// --- M1: characters that hide or reorder text are made visible ---------------------------------

describe("ActionCard: invisible and reordering characters are shown as <U+XXXX> (M1)", () => {
  it("marks them in a Bash command, and keeps newline and tab as they are", async () => {
    const engine = createEngine();
    engine.input = () =>
      json(200, held({ command: "ls \u202egnp.exe\u200b\u0007 \u0085end\tTAB\nnext" }));
    await mount({ engine });
    await vi.waitFor(() =>
      expect(inputEl()?.textContent).toBe(
        "ls <U+202E>gnp.exe<U+200B><U+0007> <U+0085>end\tTAB\nnext",
      ),
    );
    expect(hiddenChars(cardEl()?.textContent ?? "")).toEqual([]);
  });

  it("marks them in a pretty-JSON input", async () => {
    const engine = createEngine();
    engine.input = () =>
      json(200, held({ command: "echo hi", description: "a\u202eb\u2069c\u2060d\ufeffe" }));
    await mount({ engine });
    await vi.waitFor(() =>
      expect(inputEl()?.textContent).toContain("a<U+202E>b<U+2069>c<U+2060>d<U+FEFF>e"),
    );
    expect(hiddenChars(cardEl()?.textContent ?? "")).toEqual([]);
  });

  it("marks them in the agent name, session id, tool name and working directory", async () => {
    const engine = createEngine();
    engine.input = () => json(200, { ...held(), cwd: "/work/\u2066app\u200d" });
    const store = makeStore({
      agents: { a1: { id: "a1", displayName: "Ada\u202eevil" } },
      requests: {
        "req-1": request({ sessionId: "sess\u200b-1", toolName: "Ba\u0007sh" }),
      },
    });
    await mount({ engine, store });
    await loaded();
    await vi.waitFor(() => expect(cardText()).toContain("/work/<U+2066>app<U+200D>"));
    expect(cardText()).toContain("Ada<U+202E>evil");
    expect(cardText()).toContain("sess<U+200B>-1");
    expect(cardText()).toContain("Ba<U+0007>sh");
    expect(hiddenChars(cardEl()?.textContent ?? "")).toEqual([]);
  });

  it.each([
    ["a Bash command", { command: `echo \u202e ${GITHUB}\u200b done` }, "echo <U+202E> "],
    [
      "a pretty-JSON input",
      { command: `echo \u202e ${GITHUB}\u200b done`, description: "d" },
      "echo <U+202E> ",
    ],
  ])("keeps mask offsets right around markers in %s", async (_name, toolInput, lead) => {
    const engine = createEngine();
    engine.input = () => json(200, held(toolInput));
    await mount({ engine });
    await loaded();
    await expect.poll(() => reveals().elements().length).toBe(1);
    expect(inputEl()?.textContent).toContain(lead);
    expect(inputEl()?.textContent).toContain("<U+200B> done");
    expect(cardEl()?.innerHTML).not.toContain(GITHUB);
    await reveals().first().click();
    expect(inputEl()?.textContent).toContain(`${lead}${GITHUB}<U+200B> done`);
  });
});

// --- M2: a long input must be read to the end before Allow -------------------------------------

describe("ActionCard: an input that overflows its box must be scrolled to the end (M2)", () => {
  const long = Array.from({ length: 200 }, (_, i) => `echo step ${i}`).join("\n");

  it("shows how many lines there are and keeps Allow off until the box is scrolled to the end", async () => {
    const engine = createEngine();
    engine.input = () => json(200, held(long));
    await mount({ engine });
    await vi.waitFor(() => expect(inputEl()?.textContent).toBe(long));
    const box = inputEl() as HTMLElement;
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
    expect(cardText()).toMatch(/\b200 lines\b/i);

    await sleep(800); // past the settle delay
    await expect.element(allow()).toBeDisabled();
    box.scrollTop = Math.floor((box.scrollHeight - box.clientHeight) / 2);
    await sleep(150);
    await expect.element(allow()).toBeDisabled();
    await expect.element(deny()).toBeEnabled();

    box.scrollTop = box.scrollHeight;
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
  });

  it("does not gate Allow for an input that fits", async () => {
    const engine = createEngine();
    engine.input = () => json(200, held("echo one\necho two\necho three"));
    await mount({ engine });
    await loaded();
    const box = inputEl() as HTMLElement;
    expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight);
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
  });
});

// --- L1: the right request, and a settle delay -------------------------------------------------

describe("ActionCard: the exact input must be for this request, and Allow settles (L1)", () => {
  it("treats a 200 for a different request as a failed load", async () => {
    const engine = createEngine();
    engine.input = () => json(200, { ...held({ command: "rm -rf /" }), requestId: "req-OTHER" });
    await mount({ engine });
    await vi.waitFor(() => expect(cardText()).toMatch(/could not load/i));
    expect(inputEl()).toBeNull();
    expect(cardText()).not.toContain("rm -rf");
    await expect.element(allow()).toBeDisabled();
    await expect.element(deny()).toBeEnabled();
  });

  it("keeps Allow off for about half a second after the input renders", async () => {
    await mount();
    await vi.waitFor(() => expect(inputEl()?.textContent ?? "").not.toBe(""));
    const seen = performance.now();
    expect((allow().element() as HTMLButtonElement).disabled).toBe(true);
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
    expect(performance.now() - seen).toBeGreaterThanOrEqual(300);
  });

  it("settles again for the input of a newly selected request", async () => {
    const inputs = { "req-1": "echo one", "req-2": "echo two" };
    const { reselect } = await mount({ store: twoAgents(), engine: routedEngine(inputs) });
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
    await reselect("a2");
    await vi.waitFor(() => expect(inputEl()?.textContent).toBe("echo two"));
    expect((allow().element() as HTMLButtonElement).disabled).toBe(true);
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
  });
});

// --- L2, L3: the clipboard text and the note --------------------------------------------------

describe("ActionCard: copy-only text and the deny note (L2, L3)", () => {
  const dirty = "/work/app\u001b]0;pwned\u0007\nrm -rf ~\r";

  it.each([
    ["the command result's", true],
    ["the exact input's (when the result has none)", false],
  ])(
    "strips control characters from the working directory in %s copy-only text",
    async (_n, fromResult) => {
      const writeText = stubClipboard();
      const engine = createEngine();
      engine.input = () => json(200, { ...held(), cwd: fromResult ? "/work/app" : dirty });
      engine.command = (body) =>
        json(200, {
          command: {
            id: "c-open",
            type: "session.open",
            requestId: body.requestId,
            status: "succeeded",
            result: {
              outcome: "copy-only",
              sessionId: "sess-1",
              ...(fromResult ? { cwd: dirty } : {}),
            },
          },
        });
      await mount({ engine });
      await loaded();
      await openSession().click();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const copied = writeText.mock.calls[0]?.[0] ?? "";
      expect(copied).toContain("sess-1");
      expect(copied).toContain("/work/app");
      expect(copied.split("\n")).toHaveLength(2);
      expect(hiddenChars(copied)).toEqual([]);
      expect(copied).not.toContain("\t");
    },
  );

  it("limits the deny note to 1000 characters (the engine's MAX_DENY_MESSAGE_CHARS)", async () => {
    await mount();
    await loaded();
    expect((note().element() as HTMLTextAreaElement).maxLength).toBe(1000);
  });
});

// --- selection change starts clean (code review 7) ---------------------------------------------

describe("ActionCard: a new selection starts clean", () => {
  const inputs = { "req-1": `export A=${GITHUB}`, "req-2": `export B=${SLACK}` };

  it("select A, reveal its mask and type a note; select B: B is masked, Allow off, note empty", async () => {
    const { reselect } = await mount({ store: twoAgents(), engine: routedEngine(inputs) });
    await expect.poll(() => reveals().elements().length).toBe(1);
    await reveals().first().click();
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
    await note().fill("note for A");

    await reselect("a2");
    await vi.waitFor(() => expect(inputEl()?.textContent ?? "").toContain("export B="));
    expect(cardText()).toContain("Bo");
    expect(reveals().elements()).toHaveLength(1);
    expect(inputEl()?.textContent).not.toContain(SLACK);
    expect(cardEl()?.innerHTML).not.toContain(SLACK);
    await expect.element(allow()).toBeDisabled();
    expect((note().element() as HTMLTextAreaElement).value).toBe("");
    expect(stateOf()).toBe("open");
  });

  it("select A, send; select B: B is open and not sent", async () => {
    const { reselect } = await mount({ store: twoAgents(), engine: routedEngine(inputs) });
    await expect.poll(() => reveals().elements().length).toBe(1);
    await deny().click();
    await vi.waitFor(() => expect(stateOf()).toBe("sent"));

    await reselect("a2");
    await vi.waitFor(() => expect(cardText()).toContain("Bo"));
    expect(stateOf()).toBe("open");
    expect(cardText()).not.toMatch(/sent, unconfirmed/i);
    await expect.element(deny()).toBeEnabled();
    await expect.element(openSession()).toBeEnabled();
  });
});

// --- unmount (code review 8) -------------------------------------------------------------------

describe("ActionCard: unmount", () => {
  it("aborts the exact-input request with an AbortSignal", async () => {
    const pending = deferred<Response>();
    const engine = createEngine();
    engine.input = () => pending.promise;
    const signals = trackSignals(engine);
    const { view } = await mount({ engine });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]?.aborted).toBe(false);
    await view.unmount();
    expect(signals[0]?.aborted).toBe(true);
  });

  it("aborts the request of the card that the selection moved away from", async () => {
    const engine = routedEngine({ "req-1": "echo one", "req-2": "echo two" });
    const base = engine.input;
    engine.input = () =>
      engine.calls[engine.calls.length - 1]?.path.includes("req-1")
        ? new Promise<Response>(() => {})
        : base();
    const signals = trackSignals(engine);
    const { reselect } = await mount({ store: twoAgents(), engine });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    await reselect("a2");
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("clears the elapsed-time interval", async () => {
    const created: Array<{ id: unknown; ms: unknown }> = [];
    const cleared: unknown[] = [];
    const realSet = window.setInterval.bind(window);
    const realClear = window.clearInterval.bind(window);
    const set = vi.spyOn(window, "setInterval").mockImplementation(((
      fn: TimerHandler,
      ms?: number,
      ...args: unknown[]
    ) => {
      const id = realSet(fn, ms, ...args);
      created.push({ id, ms });
      return id;
    }) as unknown as typeof setInterval);
    const clear = vi.spyOn(window, "clearInterval").mockImplementation(((id?: number) => {
      cleared.push(id);
      realClear(id);
    }) as typeof clearInterval);
    try {
      const { view } = await mount();
      await loaded();
      const cards = created.filter((c) => typeof c.ms === "number" && c.ms >= 250);
      expect(cards.length).toBeGreaterThan(0);
      await view.unmount();
      for (const c of cards) expect(cleared).toContain(c.id);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });

  it("does nothing once unmounted when a pending session.open answers (no clipboard write)", async () => {
    const writeText = stubClipboard();
    const pending = deferred<Response>();
    const engine = createEngine();
    engine.command = () => pending.promise;
    const { view } = await mount({ engine });
    await loaded();
    await openSession().click();
    await vi.waitFor(() => expect(posts(engine)).toHaveLength(1));
    await view.unmount();
    pending.resolve(
      json(200, {
        command: {
          id: "c-open",
          type: "session.open",
          status: "succeeded",
          result: { outcome: "copy-only", sessionId: "sess-1", cwd: "/work/app" },
        },
      }),
    );
    await sleep(200);
    expect(writeText).not.toHaveBeenCalled();
  });
});

// --- the bridge no longer holds the request (#271 D2) ------------------------------------------
//
// After the fall-through the bridge drops the exact input and `decide` fails as expired. That is
// not a dead end: the card becomes the open-session-only variant (Open session enabled, and the
// text says the hold ended and to answer in the terminal or open the session). A state the store
// recorded outranks it.

describe("ActionCard: the bridge no longer holds the request (#271 D2)", () => {
  async function expectOpenSessionOnly() {
    await vi.waitFor(() => expect(cardEl()?.getAttribute("data-variant")).toBe("open-only"));
    await expect.element(openSession()).toBeEnabled();
    await expect.element(allow()).not.toBeInTheDocument();
    await expect.element(deny()).not.toBeInTheDocument();
    expect(cardText()).toMatch(/\b(hold|holds|held)\b/i);
    expect(cardText()).toMatch(/terminal/i);
    expect(cardText()).not.toContain(RAW);
  }

  it("a 410 on the exact input turns the card into the open-session-only variant", async () => {
    const engine = createEngine();
    engine.input = () => errorResponse(410, "request_expired");
    await mount({ engine });
    await expectOpenSessionOnly();
  });

  it("request_expired when sending turns the card into the open-session-only variant", async () => {
    const engine = createEngine();
    engine.command = () => errorResponse(410, "request_expired");
    await mount({ engine });
    await loaded();
    await allow().click();
    await expectOpenSessionOnly();
    expect(cardText()).not.toMatch(/sent, unconfirmed/i);
  });

  it("Open session still works from that variant", async () => {
    const writeText = stubClipboard();
    const engine = createEngine();
    engine.input = () => errorResponse(410, "request_expired");
    await mount({ engine });
    await expectOpenSessionOnly();
    await openSession().click();
    await vi.waitFor(() => expect(posts(engine)).toHaveLength(1));
    expect(posts(engine)[0]?.body).toMatchObject({ type: "session.open", sessionId: "sess-1" });
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["answered_elsewhere", "answered_elsewhere", "answered_elsewhere"],
    ["answered_here", "answered_here", undefined],
    ["a state the card does not know", "cancelled", "closed"],
  ])(
    "a recorded %s outranks a 410 on the input: nothing is enabled",
    async (_name, state, dataState) => {
      const engine = createEngine();
      engine.input = () => errorResponse(410, "request_expired");
      const store = makeStore({ requests: { "req-1": request({ state }) } });
      await mount({ engine, store });
      await sleep(300);
      expect(stateOf()).not.toBe("open");
      expect(stateOf()).not.toBe("expired"); // the recorded state outranks the 410
      if (dataState !== undefined) expect(stateOf()).toBe(dataState);
      expect(cardEl()?.getAttribute("data-variant")).not.toBe("open-only");
      expect(enabledButtons()).toEqual([]);
    },
  );

  it("a state recorded after a 410 on decide takes over from the open-session-only variant", async () => {
    const engine = createEngine();
    engine.command = () => errorResponse(410, "request_expired");
    const { store } = await mount({ engine });
    await loaded();
    await allow().click();
    await expectOpenSessionOnly();
    closeRequest(store, "req-1", "answered_elsewhere");
    await vi.waitFor(() => expect(stateOf()).toBe("answered_elsewhere"));
    expect(enabledButtons()).toEqual([]);
  });
});

// --- a request recorded as answered here (code review 10) --------------------------------------

describe("ActionCard: a request answered from another tab", () => {
  it("shows its recorded state and disables every button", async () => {
    const store = makeStore({ requests: { "req-1": request({ state: "answered_here" }) } });
    await mount({ store });
    await vi.waitFor(() => expect(stateOf()).not.toBe("open"));
    expect(cardText()).toMatch(/answered|decision|sent|no longer open/i);
    await expectAllDisabled();
  });
});

// --- what counts as sent (code review 11, 12) --------------------------------------------------

describe("ActionCard: sent means the engine delivered it", () => {
  it.each([["failed"], ["requested"], ["rejected"], ["a missing status"]])(
    "a 200 whose command status is %s is an error, not 'sent'",
    async (status) => {
      const engine = createEngine();
      engine.command = (body) =>
        json(200, {
          command: {
            id: "c",
            type: "permission.decide",
            requestId: body.requestId,
            ...(status === "a missing status" ? {} : { status }),
          },
        });
      await mount({ engine });
      await loaded();
      await deny().click();
      await vi.waitFor(() => expect(posts(engine)).toHaveLength(1));
      await sleep(150);
      expect(enabledButtons()).toContain("Deny");
      expect(stateOf()).toBe("open");
      expect(cardText()).not.toMatch(/sent, unconfirmed/i);
      expect(cardEl()?.querySelector('[role="alert"]')).not.toBeNull();
    },
  );

  it.each([
    ["an HTML body", () => new Response("<html>ok</html>", { status: 200 })],
    ["an empty body", () => new Response("", { status: 200 })],
    ["a body with no command", () => json(200, { ok: true })],
  ])("a 200 with %s is an error, not 'sent'", async (_name, respond) => {
    const engine = createEngine();
    engine.command = respond;
    await mount({ engine });
    await loaded();
    await deny().click();
    await vi.waitFor(() => expect(posts(engine)).toHaveLength(1));
    await sleep(150);
    expect(enabledButtons()).toContain("Deny");
    expect(stateOf()).toBe("open");
    expect(cardText()).not.toMatch(/sent, unconfirmed/i);
    expect(cardEl()?.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("a network failure says the decision may have been sent, and the retry reuses the key", async () => {
    const engine = createEngine();
    const answer = engine.command;
    let calls = 0;
    engine.command = (body) => {
      calls += 1;
      if (calls === 1) throw new TypeError(RAW);
      return answer(body);
    };
    await mount({ engine });
    await loaded();
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
    await allow().click();
    await vi.waitFor(() =>
      expect(cardText()).toMatch(/(may|might)( already)? have been (sent|delivered|received)/i),
    );
    expect(cardText()).not.toContain(RAW);
    expect(stateOf()).toBe("open");
    await expect.element(allow()).toBeEnabled();

    await allow().click();
    await vi.waitFor(() => expect(stateOf()).toBe("sent"));
    expect(posts(engine)).toHaveLength(2);
    const [first, second] = posts(engine).map((p) => p.body?.idempotencyKey);
    expect(first).toEqual(expect.any(String));
    expect(second).toBe(first);
  });
});

// --- timeouts (code review 13) -----------------------------------------------------------------

describe("ActionCard: a request that never answers ends with a message", () => {
  it("a hung exact-input request ends after the timeout; Deny and Open session stay usable", async () => {
    const engine = createEngine();
    hangOn(engine, (url) => url.startsWith("/v1/requests/"));
    const timers = holdLongTimers();
    try {
      await mount({ engine });
      await vi.waitFor(() => expect(cardText()).toMatch(/loading/i));
      await vi.waitFor(() => expect(timers.count()).toBeGreaterThan(0));
      expect(timers.delays.every((ms) => ms >= 5000 && ms <= 15_000)).toBe(true);
      timers.fire();
    } finally {
      timers.restore();
    }
    await vi.waitFor(() => expect(cardText()).toMatch(/could not load|timed out|took too long/i));
    expect(cardText()).not.toMatch(/loading/i);
    await expect.element(allow()).toBeDisabled();
    await expect.element(deny()).toBeEnabled();
    await expect.element(openSession()).toBeEnabled();
  });

  it("a hung command ends after the timeout with a clear message and re-enabled buttons", async () => {
    const engine = createEngine();
    hangOn(engine, (url, init) => url === "/v1/commands" && init?.method === "POST");
    await mount({ engine });
    await loaded();
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
    const timers = holdLongTimers();
    try {
      (deny().element() as HTMLButtonElement).click();
      await vi.waitFor(() => expect(timers.count()).toBeGreaterThan(0));
      expect(timers.delays.every((ms) => ms >= 5000 && ms <= 15_000)).toBe(true);
      await expect.element(deny()).toBeDisabled();
      timers.fire();
    } finally {
      timers.restore();
    }
    await vi.waitFor(() =>
      expect(cardText()).toMatch(/timed out|too long|not respond|no response|may have been/i),
    );
    expect(stateOf()).toBe("open");
    await expect.element(deny()).toBeEnabled();
    await expect.element(openSession()).toBeEnabled();
    await expect.element(allow()).toBeEnabled();
    expect(posts(engine)).toHaveLength(1);
  });
});

// --- focus (code review 14) --------------------------------------------------------------------

describe("ActionCard: focus follows what the user did", () => {
  it("after a reveal, focus goes to the next reveal button, then to the revealed text", async () => {
    const engine = createEngine();
    engine.input = () =>
      json(
        200,
        held(
          `curl -H "Authorization: Bearer ${BEARER}" https://api.example.com && export GH=${GITHUB}`,
        ),
      );
    await mount({ engine });
    await expect.poll(() => reveals().elements().length).toBe(2);

    await reveals().first().click();
    await vi.waitFor(() => expect(reveals().elements()).toHaveLength(1));
    await vi.waitFor(() => expect(document.activeElement).toBe(reveals().element()));

    await reveals().first().click();
    await vi.waitFor(() => expect(reveals().elements()).toHaveLength(0));
    await vi.waitFor(() => {
      const active = document.activeElement;
      expect(active).not.toBe(document.body);
      expect(inputEl()?.contains(active)).toBe(true);
      expect(active?.textContent).toContain(GITHUB);
    });
  });

  const statusEl = () => cardEl()?.querySelector<HTMLElement>('[role="status"]') ?? null;

  it("has a role=status live region before anything is sent, and focuses it after a send", async () => {
    await mount();
    await loaded();
    const before = statusEl();
    expect(before).not.toBeNull();
    expect(before?.textContent).not.toMatch(/sent/i);

    await deny().click();
    await vi.waitFor(() => expect(stateOf()).toBe("sent"));
    expect(statusEl()).toBe(before);
    expect(before?.textContent).toMatch(/sent, unconfirmed/i);
    expect(document.activeElement).toBe(before);
  });
});

// --- a kept target that is no longer live (code review 15) -------------------------------------

describe("ActionCard: a kept card whose request is no longer live offers no decision", () => {
  const decisions = () => enabledButtons().filter((t) => t === "Allow once" || t === "Deny");

  it("a request that left attention while still open and unsent", async () => {
    const { store } = await mount();
    await loaded();
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
    store.setState({ attention: [] });
    await sleep(200);
    expect(decisions()).toEqual([]);
  });

  it("a request that is gone from state after a resnapshot", async () => {
    const { store } = await mount();
    await loaded();
    await expect.element(allow(), { timeout: SETTLE }).toBeEnabled();
    const current = store.getState().state as unknown as { requests: Record<string, unknown> };
    store.setState({ attention: [], state: { ...current, requests: {} } as never });
    await sleep(200);
    expect(decisions()).toEqual([]);
  });
});
