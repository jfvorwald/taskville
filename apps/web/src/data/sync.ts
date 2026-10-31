import { SESSION_HEADER } from "../pairing/pair.ts";
import {
  type ProjectState,
  REDUCER_VERSION,
  snapshotResponseSchema,
  sseFrameSchema,
} from "./domain.ts";
import { readSseFrames } from "./sse.ts";
import type { DataStore, SyncError } from "./store.ts";

// Keeps a DataStore in step with the engine (ARCHITECTURE.md section 10): take a snapshot at
// cursor N, stream events after N, apply each exactly once in sequence. On disconnect keep the
// last view and mark it stale, then resume from the store's own cursor so no event is missed
// or applied twice. A `resnapshot` frame, a skipped sequence or an unparseable frame means the
// client cannot trust its position, so it starts over from a fresh snapshot.

export interface SyncOptions {
  store: DataStore;
  projectId: string;
  /** The paired session secret (`useSession()`), sent as `X-Taskville-Session` on every request. */
  secret: string;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Waits `ms`, or rejects/returns early on abort. Default is an abortable timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface Sync {
  /** Stops the loop and cancels the open request. Resolves once the loop has exited. */
  stop(): Promise<void>;
}

/** Delay before retry number `attempt`: 0 at once, then 0.5 s doubling to 15 s. */
export function backoffMs(attempt: number): number {
  return attempt <= 0 ? 0 : Math.min(500 * 2 ** (attempt - 1), 15_000);
}

/** The client cannot continue from its cursor: fetch a new snapshot. */
class Resnapshot extends Error {}
/** Retrying will not help. */
class Fatal extends Error {
  readonly code: SyncError;
  constructor(code: SyncError) {
    super(code);
    this.code = code;
  }
}

export function startSync(options: SyncOptions): Sync {
  const controller = new AbortController();
  const done = run(options, controller.signal);
  return {
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

async function run(options: SyncOptions, signal: AbortSignal): Promise<void> {
  const { store, projectId, secret } = options;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? abortableSleep;
  const headers = { [SESSION_HEADER]: secret };
  const base = `/v1/projects/${encodeURIComponent(projectId)}`;
  const actions = () => store.getState();

  actions().reset(projectId);
  let needSnapshot = true;
  let attempt = 0;

  while (!signal.aborted) {
    try {
      if (needSnapshot) {
        actions().applySnapshotState(await fetchSnapshot(doFetch, base, headers, signal));
        needSnapshot = false;
      }
      const after = actions().cursor;
      const response = await doFetch(`${base}/events?after=${after}`, {
        headers: { ...headers, Accept: "text/event-stream" },
        signal,
      });
      checkStatus(response);
      if (response.body === null) throw new Error("event stream has no body");
      attempt = 0;
      actions().setConnection("live");
      await consume(store, response.body);
      // The server closed the stream cleanly: same as a drop, resume from the cursor.
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof Fatal) {
        actions().fail(error.code);
        return;
      }
      if (error instanceof Resnapshot) needSnapshot = true;
    }
    if (signal.aborted) return;
    // Before the first snapshot there is no view to mark stale: the app is still connecting.
    if (actions().state !== null) actions().setConnection("stale");
    try {
      await sleep(backoffMs(attempt), signal);
    } catch {
      return;
    }
    attempt += 1;
  }
}

async function fetchSnapshot(
  doFetch: typeof fetch,
  base: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<ProjectState> {
  const response = await doFetch(`${base}/snapshot`, { headers, signal });
  checkStatus(response);
  const parsed = snapshotResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Fatal("bad_response");
  const snapshot = parsed.data;
  if (snapshot.reducerVersion !== REDUCER_VERSION) throw new Fatal("reducer_mismatch");
  const state = snapshot.state as unknown as ProjectState;
  if (state.head !== snapshot.cursor) throw new Fatal("bad_response");
  return state;
}

function checkStatus(response: Response): void {
  if (response.status === 401) throw new Fatal("unauthorized");
  if (response.status === 404) throw new Fatal("unknown_project");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

/** Applies stream frames until the stream ends; throws Resnapshot when the cursor is untrustworthy. */
async function consume(store: DataStore, body: ReadableStream<Uint8Array>): Promise<void> {
  for await (const raw of readSseFrames(body)) {
    let data: unknown;
    try {
      data = raw.data === undefined ? undefined : JSON.parse(raw.data);
    } catch {
      throw new Resnapshot("unparseable frame");
    }
    const parsed = sseFrameSchema.safeParse({
      event: raw.event,
      ...(raw.id === undefined ? {} : { id: Number(raw.id) }),
      data,
    });
    if (!parsed.success) throw new Resnapshot("invalid frame");
    const frame = parsed.data;
    if (frame.event === "heartbeat") continue;
    if (frame.event === "resnapshot") throw new Resnapshot(frame.data.reason);
    const cursor = store.getState().cursor;
    if (frame.id <= cursor) continue; // a replay of something already applied
    if (frame.id !== cursor + 1) throw new Resnapshot("sequence gap");
    try {
      store.getState().applyEvent(frame.data);
    } catch {
      throw new Resnapshot("reducer rejected event");
    }
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
