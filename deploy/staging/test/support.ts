// Shared fakes for the staging Worker tests (M7.03). The Worker is driven the way the Workers
// runtime drives it: `worker.fetch(request, env)` with a fake `env`. No wrangler, no network.

import { vi } from "vitest";
import { createWorker, PairingStore } from "../src/worker.ts";

export const ORIGIN = "https://taskville-staging.jaqstudios.com";
export const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";
export const SESSION_HEADER = "X-Taskville-Session";
export const VALID_JWT = "valid-access-jwt";
export const RELEASE_ID = "rel-2026-11-06-3ef46a7";

export interface FakeAsset {
  readonly bytes: Uint8Array;
  readonly type: string;
}

/** An in-memory `ASSETS` binding: `/` serves `/index.html`; anything else unknown is a 404. */
export function fakeAssets(files: Record<string, FakeAsset>) {
  return {
    fetch: vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      const file = files[path === "/" ? "/index.html" : path];
      if (file === undefined) return new Response("not found", { status: 404 });
      return new Response(file.bytes, { headers: { "content-type": file.type } });
    }),
  };
}

export const DEFAULT_FILES: Record<string, FakeAsset> = {
  "/index.html": {
    type: "text/html; charset=utf-8",
    bytes: new TextEncoder().encode(
      '<!doctype html><html><body><div id="root"></div><script src="/assets/index-abc123.js"></script></body></html>\n',
    ),
  },
  "/assets/index-abc123.js": {
    type: "text/javascript",
    bytes: new TextEncoder().encode("console.log('taskville');\n"),
  },
  // Not valid UTF-8, so any text round trip or rewrite changes it.
  "/assets/logo.png": {
    type: "image/png",
    bytes: Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe, 0x80,
    ]),
  },
};

/**
 * A fake `DurableObjectNamespace` for the pairing store. The Durable Object is the exported
 * `PairingStore` class, constructed the standard way (`new PairingStore(state, env)`) over an
 * in-memory `state.storage`, so one instance serves every request like the real one.
 */
export function fakePairingNamespace(
  env: object = {},
  StoreClass: typeof PairingStore = PairingStore,
) {
  const map = new Map<string, unknown>();
  /** Every `storage.list` call's options, so tests can see what the store scans. */
  const listCalls: ({ prefix?: string } | undefined)[] = [];
  /** Every request that reached the Durable Object. */
  const stubCalls: Request[] = [];
  const state = {
    storage: {
      get: async (key: string) => map.get(key),
      put: async (key: string, value: unknown) => {
        map.set(key, value);
      },
      delete: async (key: string) => map.delete(key),
      list: async (options?: { prefix?: string }) => {
        listCalls.push(options);
        const prefix = options?.prefix ?? "";
        return new Map([...map].filter(([key]) => key.startsWith(prefix)));
      },
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
  };
  const store = new StoreClass(state as never, env as never);
  const stub = {
    fetch: (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      stubCalls.push(request.clone());
      return store.fetch(request);
    },
  };
  return {
    idFromName: (name: string) => name,
    get: () => stub,
    getByName: () => stub,
    map,
    listCalls,
    stubCalls,
  };
}

export function fakeVerifier() {
  return vi.fn(async (jwt: string) => (jwt === VALID_JWT ? { email: "owner@example.com" } : null));
}

interface WorkerModule {
  createWorker: typeof createWorker;
  PairingStore: typeof PairingStore;
}

/** A staging Worker built from a given load of the module (tests reload it for new isolates). */
export function makeStagingFrom(
  mod: WorkerModule,
  files: Record<string, FakeAsset> = DEFAULT_FILES,
) {
  const assets = fakeAssets(files);
  const pairing = fakePairingNamespace({}, mod.PairingStore);
  const env = {
    ASSETS: assets,
    PAIRING: pairing,
    RELEASE_ID,
    RELEASE_VERSION: "0.0.0-test",
    APP_ENV: "staging",
  };
  const verifyAccess = fakeVerifier();
  const worker = mod.createWorker({ verifyAccess });
  return {
    assets,
    env,
    pairing,
    verifyAccess,
    worker,
    call: (path: string, init: RequestInit = {}) =>
      worker.fetch(new Request(`${ORIGIN}${path}`, init), env as never),
    /** The same request with some bindings replaced (for example `ACCESS_ALLOWED_EMAIL`). */
    callWith: (extra: Record<string, unknown>, path: string, init: RequestInit = {}) =>
      worker.fetch(new Request(`${ORIGIN}${path}`, init), { ...env, ...extra } as never),
  };
}

export function makeStaging(files: Record<string, FakeAsset> = DEFAULT_FILES) {
  return makeStagingFrom({ createWorker, PairingStore }, files);
}

export type Staging = ReturnType<typeof makeStaging>;

export const JSON_POST = { "Content-Type": "application/json", Origin: ORIGIN };

/** The first-visit flow the App Launcher link starts: `/pair` with Access, then the exchange. */
export async function pair(staging: Staging): Promise<string> {
  const entry = await staging.call("/pair", { headers: { [ACCESS_HEADER]: VALID_JWT } });
  const code = pairingCodeFrom(entry);
  const exchange = await staging.call("/v1/pairing", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ code }),
  });
  const body = (await exchange.json()) as { session: string };
  return body.session;
}

export function pairingCodeFrom(response: Response): string {
  const location = response.headers.get("location");
  if (location === null) throw new Error(`No Location header (status ${response.status})`);
  const url = new URL(location, ORIGIN);
  const match = /^#pair=(.+)$/.exec(url.hash);
  if (url.origin !== ORIGIN || url.pathname !== "/" || match?.[1] === undefined) {
    throw new Error(`Unexpected pairing redirect ${location}`);
  }
  return decodeURIComponent(match[1]);
}

export function withSession(session: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers as Record<string, string>), [SESSION_HEADER]: session },
  };
}

export interface RawFrame {
  readonly raw: string;
  readonly event: string | undefined;
  readonly id: string | undefined;
  readonly data: string;
}

/**
 * Reads SSE frames until `done` says enough, the stream ends, or the timeout passes, then
 * cancels the stream (a live stream never ends on its own).
 */
export async function readSse(
  response: Response,
  done: (frames: RawFrame[]) => boolean,
  timeoutMs = 5000,
): Promise<RawFrame[]> {
  if (response.body === null) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: RawFrame[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (!done(frames)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), remaining);
        }),
      ]);
      clearTimeout(timer);
      if (next === "timeout" || next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const raw = `${buffer.slice(0, end)}\n\n`;
        buffer = buffer.slice(end + 2);
        frames.push(parseFrame(raw));
        end = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

function parseFrame(raw: string): RawFrame {
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("id: ")) id = line.slice(4);
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  return { raw, event, id, data: data.join("\n") };
}

/** Every event of a project, read from its SSE stream from the start. */
export async function fetchEvents(
  staging: Staging,
  session: string,
  projectId = "demo",
): Promise<Record<string, unknown>[]> {
  const projects = (await (await staging.call("/v1/projects", withSession(session))).json()) as {
    projects: { id: string; head: number }[];
  };
  const head = projects.projects.find((p) => p.id === projectId)?.head ?? 0;
  const response = await staging.call(
    `/v1/projects/${projectId}/events?after=0`,
    withSession(session),
  );
  const frames = await readSse(
    response,
    (all) => all.filter((f) => f.event === "event").length >= head,
    15_000,
  );
  return frames.filter((f) => f.event === "event").map((f) => JSON.parse(f.data));
}
