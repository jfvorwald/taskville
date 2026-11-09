import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { storedEnvelopeSchema } from "../../../../../packages/protocol/src/index.ts";
import type { StoredEnvelope } from "../../data/domain.ts";
import { useCurrentProjectId } from "../../data/project.ts";
import { createDataStore, type DataStore, dataStore } from "../../data/store.ts";
import { SESSION_HEADER } from "../../pairing/pair.ts";
import { useSession } from "../../pairing/session.tsx";
import { themeController } from "../../themes/core/index.ts";
import {
  type GitMarker,
  gitMarker,
  momentTime,
  type TimelineChoice,
  timelineChoices,
  WINDOW_EVENTS,
} from "../archives/archive-timelines.ts";
import { EMPTY_FIDELITY_FRAME, type FidelityFrame } from "../fidelity/frame.ts";
import { createHistoryStore, type HistoryStore, type ReplayRate } from "../state/store.ts";
import { type CrewRun, crewRuns } from "./crew-bars.tsx";
import { currentTaskId } from "./how-did-we.tsx";

export interface RecordedMoment {
  readonly sequence: number;
  readonly time: number;
  readonly agentId: string | undefined;
  readonly marker:
    | "Needs you"
    | "Possibly needs you"
    | "Task completed"
    | "Commit"
    | GitMarker
    | undefined;
  /** The request a non-late `request.opened` at this sequence opened. */
  readonly requestId?: string | undefined;
}

interface Presentation {
  readonly fidelity: FidelityFrame;
  moments: readonly RecordedMoment[];
  agents: readonly { id: string; name: string }[];
  crew: readonly CrewRun[];
  /** The live recording and archives to choose from, and the one presented. */
  timelines: readonly TimelineChoice[];
  timeline: TimelineChoice | null;
  openTimeline(id: string): void;
  /** Re-reads the list so archives finished since entering are offered; the replay stays put. */
  refreshTimelines(): void;
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
  enterTask(agentId: string, taskId: string): void;
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
  crew: [] as readonly CrewRun[],
  timelines: [] as readonly TimelineChoice[],
  timeline: null,
};
const fallback: Presentation = {
  ...live,
  openTimeline() {},
  refreshTimelines() {},
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
  enterTask() {},
  seek() {},
  exit() {},
};
const Context = createContext<Presentation | null>(null);

export function useHistoryPresentation(): Presentation {
  return useContext(Context) ?? fallback;
}

/** Owns replay resources in an effect, including StrictMode's setup/cleanup cycle. */
export function HistoryProvider({
  children,
  refreshIntervalMs = 15_000,
}: {
  children: ReactNode;
  /** How often the timeline list is re-read while history is open. */
  refreshIntervalMs?: number;
}) {
  const epoch = useRef(0);
  const refreshEvery = useRef(refreshIntervalMs);
  refreshEvery.current = refreshIntervalMs;
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
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    // The loaded window: moments[i] and recorded[i] are consecutive sequences from moments[0].
    let moments: RecordedMoment[] = [];
    let recorded: StoredEnvelope[] = [];
    let loaded: TimelineChoice | undefined;
    // The window the strip, slider and crew bars were last told about; a failed or superseded
    // seek returns to it, never to another seek's unpublished candidate.
    let published: { moments: RecordedMoment[]; recorded: StoredEnvelope[] } = {
      moments: [],
      recorded: [],
    };
    // Registrations and finishes recorded before the loaded window, from sequence 1 on. A run
    // that starts before the window and ends inside it needs them for its name, parent and start.
    let crewHistory: StoredEnvelope[] = [];
    let crewScanned = 0;
    let crewScanning = false;
    // The head projection may prune retired agents; the loaded log still records them.
    let agents = new Map<
      string,
      { id: string; name: string; sourceId?: string; sourceAgentId?: string }
    >();
    let presentedSequence: number | null = null;
    /** Events of `recorded` up to and including this sequence. */
    const recordedUpTo = (sequence: number) =>
      Math.max(0, sequence - (moments[0]?.sequence ?? 1) + 1);
    let explicitSeek = false;
    let seekGeneration = 0;
    let fidelity = EMPTY_FIDELITY_FRAME;
    function resetFidelity(sequence: number | null = null) {
      fidelity = {
        epoch: ++epoch.current,
        revision: 0,
        events: [],
        baseline: sequence === null ? [] : recorded.slice(0, recordedUpTo(sequence)),
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
      clearInterval(refreshTimer);
      refreshTimer = undefined;
      moments = [];
      recorded = [];
      loaded = undefined;
      published = { moments: [], recorded: [] };
      crewHistory = [];
      crewScanned = 0;
      crewScanning = false;
      agents = new Map();
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
      const known = published.moments.find((item) => item.sequence === sequence);
      // Only a windowed archive has positions it has not loaded yet.
      if (
        !known &&
        !(loaded && windowed(loaded) && sequence >= range.first && sequence <= range.last)
      )
        return;
      const seekToken = ++seekGeneration;
      explicitSeek = true;
      controller.getState().pause();
      // A state read still pending from an earlier seek must not move the city once this one began.
      controller.getState().cancelRead();
      const requestGeneration = generation;
      const store = controller;
      // An earlier seek's candidate window is dropped; this seek starts from what is on screen.
      moments = published.moments;
      recorded = published.recorded;
      const current = () => requestGeneration === generation && seekToken === seekGeneration;
      void (async () => {
        let moment = known;
        if (!moment && loaded) {
          // Seeking into an unloaded range moves the window there.
          const from = Math.max(range.first, sequence - Math.floor(WINDOW_EVENTS / 2));
          const to = Math.min(range.last, from + WINDOW_EVENTS - 1);
          const chunk = await walk(loaded, from, to);
          if (!chunk || !current()) return;
          // The new window is installed for the seek to validate against, but only published
          // once its own state read succeeds and no later seek has superseded this one.
          moments = chunk.moments;
          recorded = chunk.recorded;
          moment = moments.find((item) => item.sequence === sequence);
          if (!moment) throw new Error("events");
          await store.getState().seekSequence(moment.sequence, moment.time);
          if (current()) publishWindow();
          return;
        }
        if (!moment) throw new Error("events");
        await store.getState().seekSequence(moment.sequence, moment.time);
      })()
        .catch(() => {
          if (!current()) return;
          // A failure returns to the window still on screen.
          moments = published.moments;
          recorded = published.recorded;
          publish({ error: "Could not load recorded state." });
        })
        .finally(() => {
          if (current()) explicitSeek = false;
        });
    }
    /** Whether only a window of the timeline is held: long archives, never the live recording. */
    const windowed = (timeline: TimelineChoice) =>
      timeline.kind === "archive" &&
      timeline.lastSequence - timeline.firstSequence + 1 > WINDOW_EVENTS;
    /** Walks the server-issued cursors over sequences `from` to `to`, the end pinned. */
    async function walk(
      timeline: TimelineChoice,
      from: number,
      to: number,
      target?: { agentId: string; taskId: string },
    ) {
      const requestGeneration = generation;
      const signal = metadata?.signal ?? null;
      const chunkMoments: RecordedMoment[] = [];
      const chunk: StoredEnvelope[] = [];
      let cursor: string | null = null;
      const cursors = new Set<string>();
      const eventIds = new Set<string>();
      let expected = from;
      let taskStart: { sequence: number; time: number } | undefined;
      do {
        const query = new URLSearchParams({ from: String(from), to: String(to) });
        if (cursor) query.set("cursor", cursor);
        const pageResponse = await fetch(
          `/v1/timelines/${encodeURIComponent(timeline.id)}/events?${query}`,
          { headers: { [SESSION_HEADER]: secret }, signal },
        );
        if (!pageResponse.ok) throw new Error("events");
        const page = await pageResponse.json();
        if (!active || requestGeneration !== generation) return undefined;
        if (page?.timelineId !== timeline.id || !Array.isArray(page.events) || !page.events.length)
          throw new Error("events");
        for (const raw of page.events) {
          const event = storedEnvelopeSchema.parse(raw);
          const time = momentTime(timeline, event);
          if (
            event.projectId !== projectId ||
            event.ingestSequence !== expected ||
            expected > to ||
            !Number.isFinite(time) ||
            eventIds.has(event.eventId)
          )
            throw new Error("events");
          eventIds.add(event.eventId);
          if (
            target &&
            !taskStart &&
            event.type === "task.created" &&
            event.taskId === target.taskId
          )
            taskStart = { sequence: event.ingestSequence, time };
          chunk.push(event);
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
                : timeline.kind === "archive"
                  ? gitMarker(event)
                  : event.type === "git.commit"
                    ? "Commit"
                    : undefined;
          chunkMoments.push({
            sequence: expected++,
            time,
            agentId: event.agentId,
            marker,
            requestId:
              event.type === "request.opened" && !event.late ? event.payload.requestId : undefined,
          });
        }
        cursor = page.nextCursor;
        if (cursor !== null) {
          if (typeof cursor !== "string" || !cursor || cursors.has(cursor) || expected > to)
            throw new Error("cursor");
          cursors.add(cursor);
        }
      } while (cursor !== null);
      if (
        expected !== to + 1 ||
        (from === timeline.firstSequence &&
          chunkMoments[0]?.time !== Date.parse(timeline.firstAt)) ||
        (to === timeline.lastSequence && chunkMoments.at(-1)?.time !== Date.parse(timeline.lastAt))
      )
        throw new Error("events");
      return { moments: chunkMoments, recorded: chunk, taskStart };
    }
    /** Subagent runs from the loaded window and the registrations recorded before it. */
    function crewNow(timeline: TimelineChoice) {
      const bySequence = new Map<number, StoredEnvelope>();
      for (const event of crewHistory) bySequence.set(event.ingestSequence, event);
      for (const event of published.recorded) bySequence.set(event.ingestSequence, event);
      const events = [...bySequence.values()].sort((a, b) => a.ingestSequence - b.ingestSequence);
      return crewRuns(events, (event) => momentTime(timeline, event));
    }
    /** Publishes what the loaded window changed: moments, crew and agents. */
    function publishWindow() {
      const timeline = loaded;
      if (!timeline) return;
      published = { moments, recorded };
      publish({
        moments,
        crew: crewNow(timeline),
        agents: [...agents.values()].map(({ id, name }) => ({ id, name })),
      });
      void scanCrew();
    }
    /**
     * Whether a run is still unresolved: a finish with no recorded registration (a heuristic one
     * never forms a run), or a run that started before the window with no finish seen yet.
     */
    function unresolved(timeline: TimelineChoice) {
      const start = published.moments[0]?.sequence ?? 1;
      const registered = new Set<string>();
      const finished = new Set<string>();
      for (const list of [crewHistory, published.recorded])
        for (const event of list) {
          if (!event.agentId) continue;
          if (event.type === "agent.registered" && event.payload.heuristic !== true)
            registered.add(event.agentId);
          else if (event.type === "agent.finished") finished.add(event.agentId);
        }
      for (const id of finished) if (!registered.has(id)) return true;
      return crewNow(timeline).some(
        (run) => run.startSequence < start && run.finishedSequence === undefined,
      );
    }
    const agentList = () => [...agents.values()].map(({ id, name }) => ({ id, name }));
    /** Reads the events before the window, oldest first, until every finish has its registration. */
    async function scanCrew() {
      const timeline = loaded;
      const requestGeneration = generation;
      if (!timeline || crewScanning || !unresolved(timeline)) return;
      crewScanning = true;
      try {
        while (
          loaded === timeline &&
          requestGeneration === generation &&
          unresolved(timeline) &&
          crewScanned < (published.moments[0]?.sequence ?? 1) - 1
        ) {
          const from = crewScanned + 1;
          const to = Math.min((published.moments[0]?.sequence ?? 1) - 1, from + WINDOW_EVENTS - 1);
          const chunk = await walk(timeline, from, to);
          if (!chunk || loaded !== timeline || requestGeneration !== generation) return;
          crewScanned = to;
          crewHistory = crewHistory.concat(
            chunk.recorded.filter(
              (event) => event.type === "agent.registered" || event.type === "agent.finished",
            ),
          );
          publish({ crew: crewNow(timeline), agents: agentList() });
        }
      } catch {
        // The runs on screen stay valid; a later window tries again.
      } finally {
        if (requestGeneration === generation) crewScanning = false;
      }
    }
    /** Appends the events after the window's end while playback runs into them. */
    async function extend(afterSequence: number) {
      const timeline = loaded;
      const end = moments.at(-1);
      if (
        !timeline ||
        !end ||
        end.sequence !== afterSequence ||
        end.sequence >= timeline.lastSequence
      )
        return;
      const from = end.sequence + 1;
      const chunk = await walk(
        timeline,
        from,
        Math.min(timeline.lastSequence, from + WINDOW_EVENTS - 1),
      );
      if (!chunk || moments.at(-1)?.sequence !== end.sequence) return;
      moments = moments.concat(chunk.moments);
      recorded = recorded.concat(chunk.recorded);
      publishWindow();
    }
    async function refresh() {
      if (!active || value.mode !== "history" || value.pending) return;
      const requestGeneration = generation;
      try {
        const response = await fetch(`/v1/projects/${encodeURIComponent(projectId)}/timelines`, {
          headers: { [SESSION_HEADER]: secret },
        });
        if (!response.ok) return;
        const body = await response.json();
        if (
          !active ||
          requestGeneration !== generation ||
          value.pending ||
          body?.projectId !== projectId ||
          !Array.isArray(body.timelines)
        )
          return;
        publish({ timelines: timelineChoices(body, projectId) });
      } catch {
        // The list on screen stays valid; the next focus tries again.
      }
    }
    async function enter(target?: { agentId: string; taskId: string }, chosen?: string) {
      if (
        !active ||
        value.pending ||
        (value.mode === "history" && chosen === undefined) ||
        dataStore.getState().projectId !== projectId
      )
        return;
      if (target && currentTaskId(dataStore.getState().state, target.agentId) !== target.taskId)
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
        const choices = timelineChoices(body, projectId);
        // Without a live recording the newest archive (latest end) is the way in.
        const timeline =
          chosen !== undefined
            ? choices.find((item) => item.id === chosen)
            : (choices.find((item) => item.kind === "live") ??
              choices
                .filter((item) => item.kind === "archive")
                .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt))[0]);
        if (!timeline) {
          if (chosen === undefined) {
            publish({ pending: false, error: "No recording available." });
            return;
          }
          throw new Error("unlisted");
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
        // A long archive loads its newest window; the rest loads when seeking or playing into it.
        const start = windowed(timeline)
          ? Math.max(firstSequence, lastSequence - WINDOW_EVENTS + 1)
          : firstSequence;
        loaded = timeline;
        const walked = await walk(timeline, start, lastSequence, target);
        if (!walked) return;
        const { taskStart } = walked;
        moments = walked.moments;
        recorded = walked.recorded;
        published = { moments, recorded };
        if (target && !taskStart) throw new Error("task creation unavailable");
        explicitSeek = true;
        controller = createHistoryStore({
          liveStore: dataStore,
          timelineId: timeline.id,
          secret,
          fetch,
          now: () => Date.now(),
          moments: () => moments,
          compressGaps: timeline.kind === "archive",
          lastSequence,
          extend,
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
                events: recorded.slice(recordedUpTo(presentedSequence), recordedUpTo(sequence)),
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
          timelines: choices,
          timeline,
          moments,
          crew: crewNow(timeline),
          agents: [...agents.values()].map(({ id, name }) => ({ id, name })),
        });
        void scanCrew();
        // Archives finishing while history is open join the picker; cancel() stops this on exit.
        clearInterval(refreshTimer);
        refreshTimer = setInterval(() => void refresh(), refreshEvery.current);
        await controller
          .getState()
          .seekSequence(taskStart?.sequence ?? lastSequence, taskStart?.time ?? last);
        if (active && requestGeneration === generation) explicitSeek = false;
      } catch {
        if (active && requestGeneration === generation) {
          cancel();
          themeController.setHistory(false);
          publish({ ...live, fidelity, pending: false, error: "Could not load recording." });
        }
      }
    }
    value = {
      ...fallback,
      enter: () => {
        void enter();
      },
      enterTask: (agentId, taskId) => {
        void enter({ agentId, taskId });
      },
      openTimeline: (id) => {
        void enter(undefined, id);
      },
      refreshTimelines: () => {
        void refresh();
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
