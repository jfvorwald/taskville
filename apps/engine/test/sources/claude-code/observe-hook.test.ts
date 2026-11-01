import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_HOOKS_PATH,
  registerClaudeCodeRoutes,
} from "../../../src/sources/claude-code/index.ts";
import {
  BRIDGE_TOKEN,
  bearer,
  CLI_TOKEN,
  makeApp,
  postJson,
  sessionHeaders,
} from "../../http/helpers.ts";
import { hookId, makeSource, useProjects } from "./helpers.ts";

// M4.04 (#61): the telemetry route passes every accepted hook to the permission bridge.
//
// Pinned API: registerClaudeCodeRoutes(app, source, { observeHook }) where
//   observeHook: (payload: Record<string, unknown>) => void
// is called with the hook's raw payload, once, after the hook's events were committed and before
// the response is sent, and only when the hook was accepted: a 200 whose results hold at least
// one `accepted` event and no `ignored` flag. A hook the route rejects (bad body, wrong credential)
// or the mapper ignores is never passed. A throwing observer cannot fail the route.

const db = useProjects([{ id: "repo", roots: ["/work/repo"] }]);
const URL = `http://127.0.0.1:4807${CLAUDE_CODE_HOOKS_PATH}`;

function postToolUse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "sess-1",
    cwd: "/work/repo/src",
    prompt_id: "03dc4896-8835-47f5-a515-94a1ad4c675c",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "touch exp1.txt" },
    tool_use_id: "toolu_01Vht1XR3ioUBvjrANoTYgWa",
    ...overrides,
  };
}

function setup(observeHook: (payload: Record<string, unknown>) => void) {
  const { app, pairing } = makeApp();
  const { source } = makeSource(db());
  (registerClaudeCodeRoutes as (...args: unknown[]) => void)(app, source, { observeHook });
  return { app, pairing };
}

describe("telemetry route -> bridge.observeHook", () => {
  it("passes an accepted hook's payload to the observer, after its events were committed", async () => {
    const seen: { payload: Record<string, unknown>; stored: number }[] = [];
    const { app } = setup((payload) => {
      seen.push({ payload, stored: [...db().events("repo", 1)].length });
    });
    const payload = postToolUse();
    const res = await app.request(
      URL,
      postJson({ sourceEventId: hookId("o-1"), payload }, bearer(CLI_TOKEN)),
    );
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.payload).toEqual(payload);
    expect(seen[0]?.stored).toBe(1);
  });

  it("does not pass a hook the mapper ignores", async () => {
    const seen: unknown[] = [];
    const { app } = setup((payload) => seen.push(payload));
    const res = await app.request(
      URL,
      postJson(
        { sourceEventId: hookId("o-2"), payload: postToolUse({ hook_event_name: "Ignored" }) },
        bearer(CLI_TOKEN),
      ),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ignored?: boolean }).ignored).toBe(true);
    expect(seen).toEqual([]);
  });

  it("does not pass a hook the route rejects: bad body, bad ID, wrong credential", async () => {
    const seen: unknown[] = [];
    const { app, pairing } = setup((payload) => seen.push(payload));
    const session = pairing.exchange(pairing.issueCode()) ?? "";
    const good = { sourceEventId: hookId("o-3"), payload: postToolUse() };
    const bad = await app.request(URL, postJson({ payload: postToolUse() }, bearer(CLI_TOKEN)));
    const badId = await app.request(
      URL,
      postJson({ sourceEventId: "not-a-uuid", payload: postToolUse() }, bearer(CLI_TOKEN)),
    );
    const extra = await app.request(URL, postJson({ ...good, late: true }, bearer(CLI_TOKEN)));
    const asBridge = await app.request(URL, postJson(good, bearer(BRIDGE_TOKEN)));
    const asBrowser = await app.request(
      URL,
      postJson(good, { ...sessionHeaders(session), Origin: "http://127.0.0.1:4807" }),
    );
    const anonymous = await app.request(
      URL,
      postJson(good, { Host: "127.0.0.1:4807", Origin: "http://127.0.0.1:4807" }),
    );
    expect([bad.status, badId.status, extra.status]).toEqual([400, 400, 400]);
    expect([asBridge.status, asBrowser.status]).toEqual([403, 403]);
    expect(anonymous.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("a throwing observer cannot fail the route or undo the recorded events", async () => {
    const { app } = setup(() => {
      throw new Error("observer exploded");
    });
    const res = await app.request(
      URL,
      postJson({ sourceEventId: hookId("o-4"), payload: postToolUse() }, bearer(CLI_TOKEN)),
    );
    expect(res.status).toBe(200);
    expect([...db().events("repo", 1)]).toHaveLength(1);
  });

  it("works without an observer (the option is optional)", async () => {
    const { app } = makeApp();
    const { source } = makeSource(db());
    registerClaudeCodeRoutes(app, source);
    const res = await app.request(
      URL,
      postJson({ sourceEventId: hookId("o-5"), payload: postToolUse() }, bearer(CLI_TOKEN)),
    );
    expect(res.status).toBe(200);
  });
});
