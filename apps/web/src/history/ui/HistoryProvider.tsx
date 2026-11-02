import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { storedEnvelopeSchema } from "../../../../../packages/protocol/src/index.ts";
import type { StoredEnvelope } from "../../data/domain.ts";
import { useCurrentProjectId } from "../../data/project.ts";
import { createDataStore, type DataStore, dataStore } from "../../data/store.ts";
import { SESSION_HEADER } from "../../pairing/pair.ts";
import { useSession } from "../../pairing/session.tsx";
import { themeController } from "../../themes/core/index.ts";
import { EMPTY_FIDELITY_FRAME, type FidelityFrame } from "../fidelity/frame.ts";
import { createHistoryStore, type HistoryStore, type ReplayRate } from "../state/store.ts";

export interface RecordedMoment {
  readonly sequence: number;
  readonly time: number;
  readonly agentId: string | undefined;
  readonly marker: "Needs you" | "Possibly needs you" | "Task completed" | "Commit" | undefined;
  /** The request a non-late `request.opened` at this sequence opened. */
  readonly requestId?: string | undefined;
}

interface Presentation {
  readonly fidelity: FidelityFrame;
  moments: readonly RecordedMoment[];
  agents: readonly { id: string; name: string }[];
  mode: "live" | "history";
  store: DataStore;
  time: number | null;
  range: { first: number; last: number } | null;
  sequence: number | null;
  playing: boolean;
  rate: ReplayRate;
  play(): void;
  pause(): void;
  setRate(rate: ReplayRate): void;
  pending: boolean;
  error: string | null;
  enter(): void;
  seek(time: number): void;
  exit(): void;
}

const live = {
  mode: "live" as const,
  store: dataStore,
  time: null,
  range: null,
  moments: [] as readonly RecordedMoment[],
  agents: [] as readonly { id: string; name: string }[],
};
const fallback: Presentation = {
  ...live,
  fidelity: EMPTY_FIDELITY_FRAME,
  sequence: null,
  playing: false,
  rate: 1,
  play() {},
  pause() {},
  setRate() {},
  pending: false,
  error: null,
  enter() {},
  seek() {},
  exit() {},
};
const Context = createContext<Presentation | null>(null);

export function useHistoryPresentation(): Presentation {
  return useContext(Context) ?? fallback;
}

/** Owns replay resources in an effect, including StrictMode's setup/cleanup cycle. */
export function HistoryProvider({ children }: { children: ReactNode }) {
  const epoch = useRef(0);
  const projectId = useCurrentProjectId();
  const secret = useSession();
  const [current, setCurrent] = useState<{
    projectId: string;
    secret: string;
    value: Presentation;
  } | null>(null);
  useEffect(() => {
    let active = true;
    let generation = 0;
    let metadata: AbortController | undefined;
    let controller: HistoryStore | undefined;
    let unsubscribeHistory: (() => void) | undefined;
    let replayTime = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    let moments: RecordedMoment[] = [];
    let recorded: StoredEnvelope[] = [];
    let presentedSequence: number | null = null;
    let explicitSeek = false;
    let seekGeneration = 0;
    let fidelity = EMPTY_FIDELITY_FRAME;
    function resetFidelity(sequence: number | null = null) {
      fidelity = {
        epoch: ++epoch.current,
        revision: 0,
        events: [],
        baseline: sequence === null ? [] : recorded.slice(0, sequence),
      };
      presentedSequence = null;
    }
    const snapshot = createDataStore({ now: () => replayTime });
    snapshot.getState().reset(projectId);
    let value: Presentation;
    function publish(update: Partial<Presentation>) {
      if (!active) return;
      value = { ...value, ...update };
      setCurrent({ projectId, secret, value });
    }
    function cancel() {
      generation += 1;
      seekGeneration += 1;
      explicitSeek = false;
      clearInterval(timer);
      timer = undefined;
      moments = [];
      recorded = [];
      resetFidelity();
      metadata?.abort();
      metadata = undefined;
      unsubscribeHistory?.();
      unsubscribeHistory = undefined;
      controller?.getState().returnLive();
      controller?.dispose();
      controller = undefined;
    }
    function exit() {
      cancel();
      themeController.setHistory(false);
      publish({ ...live, fidelity, pending: false, error: null });
    }
    function seek(sequence: number) {
      const range = value.range;
      if (!active || !controller || !range || !Number.isSafeInteger(sequence)) return;
      const moment = moments.find((item) => item.sequence === sequence);
      if (!moment) return;
      const seekToken = ++seekGeneration;
      explicitSeek = true;
      controller.getState().pause();
      const requestGeneration = generation;
      void controller
        .getState()
        .seekSequence(moment.sequence, moment.time)
        .catch(() => {
          if (requestGeneration === generation && seekToken === seekGeneration)
            publish({ error: "Could not load recorded state." });
        })
        .finally(() => {
          if (requestGeneration === generation && seekToken === seekGeneration)
            explicitSeek = false;
        });
    }
    async function enter() {
      if (
        !active ||
        value.pending ||
        value.mode === "history" ||
        dataStore.getState().projectId !== projectId
      )
        return;
      cancel();
      const requestGeneration = generation;
      const abort = new AbortController();
      metadata = abort;
      publish({ pending: true, error: null });
      try {
        const response = await fetch(`/v1/projects/${encodeURIComponent(projectId)}/timelines`, {
          headers: { [SESSION_HEADER]: secret },
          signal: abort.signal,
        });
        if (!response.ok) throw new Error("metadata");
        const body = await response.json();
        if (!active || requestGeneration !== generation) return;
        if (body?.projectId !== projectId || !Array.isArray(body.timelines))
          throw new Error("metadata");
        const timeline = body.timelines.find(
          (item: { id?: unknown; projectId?: unknown; kind?: unknown } | null) =>
            item?.projectId === projectId &&
            item.id === `live:${projectId}` &&
            item.kind === "live",
        );
        if (!timeline) {
          publish({ pending: false, error: "No recording available." });
          return;
        }
        const first =
          typeof timeline.firstAt === "string" ? Date.parse(timeline.firstAt) : Number.NaN;
        const last = typeof timeline.lastAt === "string" ? Date.parse(timeline.lastAt) : Number.NaN;
        if (!Number.isFinite(first) || !Number.isFinite(last)) throw new Error("metadata");
        const firstSequence = timeline.firstSequence;
        const lastSequence = timeline.lastSequence;
        if (
          !Number.isSafeInteger(firstSequence) ||
          firstSequence !== 1 ||
          !Number.isSafeInteger(lastSequence) ||
          lastSequence < firstSequence
        )
          throw new Error("metadata");
        // Walk the server-issued cursors with the session's original end pinned.
        let cursor: string | null = null;
        const cursors = new Set<string>();
        const eventIds = new Set<string>();
        let expected = firstSequence;
        // The head projection may prune retired agents; the loaded log still records them.
        const agents = new Map<
          string,
          {
            id: string;
            name: string;
            sourceId?: string;
            sourceAgentId?: string;
          }
        >();
        do {
          const query = new URLSearchParams({
            from: String(firstSequence),
            to: String(lastSequence),
          });
          if (cursor) query.set("cursor", cursor);
          const pageResponse = await fetch(
            `/v1/timelines/${encodeURIComponent(timeline.id)}/events?${query}`,
            {
              headers: { [SESSION_HEADER]: secret },
              signal: abort.signal,
            },
          );
          if (!pageResponse.ok) throw new Error("events");
          const page = await pageResponse.json();
          if (!active || requestGeneration !== generation) return;
          if (
            page?.timelineId !== timeline.id ||
            !Array.isArray(page.events) ||
            !page.events.length
          )
            throw new Error("events");
          for (const raw of page.events) {
            const event = storedEnvelopeSchema.parse(raw);
            const time = Date.parse(event.receivedAt);
            if (
              event.projectId !== projectId ||
              event.ingestSequence !== expected ||
              expected > lastSequence ||
              !Number.isFinite(time) ||
              eventIds.has(event.eventId)
            )
              throw new Error("events");
            eventIds.add(event.eventId);
            recorded.push(event);
            if (event.agentId) {
              const before = agents.get(event.agentId);
              if (!before) agents.set(event.agentId, { id: event.agentId, name: event.agentId });
              if (
                event.type === "agent.registered" &&
                event.payload.heuristic !== true &&
                (!before?.sourceId ||
                  (before.sourceId === event.sourceId &&
                    before.sourceAgentId === event.payload.sourceAgentId))
              ) {
                agents.set(event.agentId, {
                  id: event.agentId,
                  name: event.payload.displayName,
                  sourceId: event.sourceId,
                  sourceAgentId: event.payload.sourceAgentId,
                });
              }
            }
            // Only recorded event facts become markers. Late prompts cannot open needs-you.
            const marker =
              event.type === "request.opened" && !event.late
                ? event.payload.heuristic === true
                  ? "Possibly needs you"
                  : "Needs you"
                : event.type === "task.status_changed" && event.payload.status === "completed"
                  ? "Task completed"
                  : event.type === "git.commit"
                    ? "Commit"
                    : undefined;
            moments.push({
              sequence: expected++,
              time,
              agentId: event.agentId,
              marker,
              requestId:
                event.type === "request.opened" && !event.late
                  ? event.payload.requestId
                  : undefined,
            });
          }
          cursor = page.nextCursor;
          if (cursor !== null) {
            if (
              typeof cursor !== "string" ||
              !cursor ||
              cursors.has(cursor) ||
              expected > lastSequence
            )
              throw new Error("cursor");
            cursors.add(cursor);
          }
        } while (cursor !== null);
        if (
          expected !== lastSequence + 1 ||
          moments[0]?.time !== first ||
          moments.at(-1)?.time !== last
        )
          throw new Error("events");
        explicitSeek = true;
        controller = createHistoryStore({
          liveStore: dataStore,
          timelineId: timeline.id,
          secret,
          fetch,
          now: () => Date.now(),
          moments,
        });
        unsubscribeHistory = controller.subscribe((state, before) => {
          clearInterval(timer);
          timer = undefined;
          if (state.playing && state.mode === "history") {
            const playingController = controller;
            timer = setInterval(() => {
              void playingController
                ?.getState()
                .tick()
                .catch(() => {
                  if (active && requestGeneration === generation) {
                    playingController.getState().pause();
                    publish({ error: "Could not load recorded state." });
                  }
                });
            }, 100);
          }
          // Live notifications during the initial seek must not clear its range or pending flag.
          // The live subscription below owns project/reset cancellation.
          if (state.mode === "history" && state.state && state.time !== null) {
            const sequence = state.state.head;
            if (explicitSeek && state.state !== before.state) {
              // The requested position becomes the baseline only when its read succeeds.
              resetFidelity(sequence);
            } else if (
              !explicitSeek &&
              before.playing &&
              presentedSequence !== null &&
              sequence > presentedSequence
            ) {
              fidelity = {
                ...fidelity,
                revision: fidelity.revision + 1,
                events: recorded.slice(presentedSequence, sequence),
              };
            }
            presentedSequence = sequence;
            replayTime = state.time;
            snapshot.getState().applySnapshotState(state.state);
            snapshot.getState().refreshAttention();
            themeController.setHistory(true);
            publish({
              mode: "history",
              fidelity,
              store: snapshot,
              time: state.time,
              sequence: state.state.head,
              playing: state.playing,
              rate: state.rate,
              pending: false,
              error: null,
            });
          }
        });
        publish({
          range: { first: firstSequence, last: lastSequence },
          moments,
          agents: [...agents.values()].map(({ id, name }) => ({ id, name })),
        });
        await controller.getState().seekSequence(lastSequence, last);
        if (active && requestGeneration === generation) explicitSeek = false;
      } catch {
        if (active && requestGeneration === generation) {
          cancel();
          publish({ ...live, fidelity, pending: false, error: "Could not load recording." });
        }
      }
    }
    value = {
      ...fallback,
      enter: () => {
        void enter();
      },
      seek,
      play: () => controller?.getState().play(),
      pause: () => controller?.getState().pause(),
      setRate: (rate) => controller?.getState().setRate(rate),
      exit,
    };
    publish({});
    const unsubscribeLive = dataStore.subscribe((next, before) => {
      if (next.projectId !== before.projectId || next.resetGeneration !== before.resetGeneration)
        exit();
    });
    return () => {
      active = false;
      cancel();
      unsubscribeLive();
      themeController.setHistory(false);
    };
  }, [projectId, secret]);
  const value =
    current?.projectId === projectId && current.secret === secret ? current.value : fallback;
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
