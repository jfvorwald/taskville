import { Component, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { useCurrentProjectId } from "../../../data/project.ts";
import { readSseFrames } from "../../../data/sse.ts";
import { SESSION_HEADER } from "../../../pairing/pair.ts";
import { useSession } from "../../../pairing/session.tsx";
import { createEvidenceBodyCache } from "./evidenceCache.ts";
import { LiveTab, type LiveTabProps } from "./LiveTab.tsx";

class PairingBoundary extends Component<{ children: ReactNode }, { unavailable: boolean }> {
  override state = { unavailable: false };
  static getDerivedStateFromError() {
    return { unavailable: true };
  }
  override render() {
    return this.state.unavailable ? (
      <p>Live feed unavailable. Pairing is required.</p>
    ) : (
      this.props.children
    );
  }
}

export function ConnectedLiveTab(props: Omit<LiveTabProps, "calls" | "evidence">) {
  return (
    <PairingBoundary>
      <PairedLive {...props} />
    </PairingBoundary>
  );
}

function PairedLive(props: Omit<LiveTabProps, "calls" | "evidence">) {
  const projectId = useCurrentProjectId();
  const secret = useSession();
  return (
    <SelectedLive
      key={JSON.stringify([projectId, props.agentId])}
      {...props}
      projectId={projectId}
      secret={secret}
    />
  );
}

function SelectedLive({
  projectId,
  secret,
  ...props
}: Omit<LiveTabProps, "calls" | "evidence"> & { projectId: string; secret: string }) {
  const [calls, setCalls] = useState<ToolCallFrame[]>([]);
  const [bodies] = useState(createEvidenceBodyCache);
  const [, setBodyVersion] = useState(0);
  const visibleReader = useRef<(calls: readonly ToolCallFrame[]) => void>(() => {});
  const onVisibleCalls = useCallback((calls: readonly ToolCallFrame[]) => {
    visibleReader.current(calls);
  }, []);
  const [evicted, setEvicted] = useState<ReadonlySet<string>>(() => new Set());
  const [unavailable, setUnavailable] = useState(false);
  const { agentId } = props;
  useEffect(() => {
    // The pairing secret is not part of the remount key. A new secret restarts the stream and
    // drops what the old one showed.
    setCalls((old) => (old.length ? [] : old));
    bodies.clear();
    setBodyVersion((old) => old + 1);
    setEvicted((old) => (old.size ? new Set() : old));
    const controller = new AbortController();
    const { signal } = controller;
    const headers = { [SESSION_HEADER]: secret };
    let bodyController = new AbortController();
    let generation = 0;
    let active = 0;
    let cursor = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const requested = new Map<string, object>();
    let wanted = new Map<string, object>();
    // A backlog can be thousands of calls. Accumulate in place, indexed by toolCallId, and publish
    // one copy per flush instead of copying the whole list for every frame and every body.
    let list: ToolCallFrame[] = [];
    let index = new Map<string, number>();
    let gone = new Set<string>();
    let dirty = { calls: false, bodies: false, gone: false };
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    function flush() {
      flushTimer = undefined;
      if (signal.aborted) return;
      const { calls, bodies: changedBodies, gone: changedGone } = dirty;
      dirty = { calls: false, bodies: false, gone: false };
      if (calls) setCalls(list.slice());
      if (changedBodies) setBodyVersion((old) => old + 1);
      if (changedGone) setEvicted(new Set(gone));
    }
    function publish(part: keyof typeof dirty) {
      dirty[part] = true;
      flushTimer ??= setTimeout(flush, 16);
    }
    const evidenceRetries = new Set<ReturnType<typeof setTimeout>>();
    const queue: { key: string; run: () => Promise<void> }[] = [];
    function drain() {
      while (!signal.aborted && active < 4 && queue.length) {
        const read = queue.shift();
        if (!read) break;
        active++;
        void read.run().finally(() => {
          active--;
          drain();
        });
      }
    }
    function readEvidence(call: ToolCallFrame) {
      const started = generation;
      const bodySignal = bodyController.signal;
      for (const part of ["input", "output"] as const) {
        const ref = call.evidence[part];
        if (ref?.status !== "stored" || typeof ref.id !== "string") continue;
        const key = JSON.stringify([ref.id, call.toolCallId, part]);
        const token = wanted.get(key);
        if (!token || requested.get(key) === token || gone.has(ref.id)) continue;
        // One attempt sequence per presented ref. A group may exceed the cache budget;
        // do not continually refetch its own locally evicted bodies on every publication.
        requested.set(key, token);
        const cached = bodies.get(ref.id);
        if (cached?.toolCallId === call.toolCallId && cached.part === part) continue;
        const obsolete = () =>
          signal.aborted ||
          bodySignal.aborted ||
          started !== generation ||
          wanted.get(key) !== token;
        const read = async (attempt: number): Promise<void> => {
          if (obsolete()) return;
          try {
            const response = await fetch(`/v1/evidence/${encodeURIComponent(ref.id)}`, {
              headers,
              signal: bodySignal,
            });
            if (obsolete()) return;
            if (response.status === 410) {
              gone.add(ref.id);
              publish("gone");
              return;
            }
            if (!response.ok) {
              if (response.status === 429 || response.status >= 500)
                throw new Error("Evidence unavailable");
              return;
            }
            const body: EvidenceResponse = await response.json();
            if (
              obsolete() ||
              body.id !== ref.id ||
              body.projectId !== projectId ||
              body.toolCallId !== call.toolCallId ||
              body.part !== part ||
              typeof body.text !== "string"
            )
              return;
            bodies.set(body);
            publish("bodies");
          } catch {
            if (obsolete()) return;
            if (attempt < 2) {
              const timer = setTimeout(
                () => {
                  evidenceRetries.delete(timer);
                  if (obsolete()) return;
                  queue.push({ key, run: () => read(attempt + 1) });
                  drain();
                },
                500 * 2 ** attempt,
              );
              evidenceRetries.add(timer);
            } else requested.delete(key);
            // Unavailable evidence remains not reported. Never log bodies or credentials.
          }
        };
        queue.push({ key, run: () => read(0) });
      }
      drain();
    }
    visibleReader.current = (visible) => {
      const next = new Map<string, object>();
      for (const call of visible) {
        for (const part of ["input", "output"] as const) {
          const ref = call.evidence[part];
          if (ref?.status !== "stored" || typeof ref.id !== "string") continue;
          const key = JSON.stringify([ref.id, call.toolCallId, part]);
          next.set(key, wanted.get(key) ?? {});
        }
      }
      wanted = next;
      for (const key of requested.keys()) if (!wanted.has(key)) requested.delete(key);
      // Do not drain work for a range the reader has already left.
      for (let at = queue.length - 1; at >= 0; at--) {
        if (!wanted.has(queue[at].key)) queue.splice(at, 1);
      }
      for (const call of visible) readEvidence(call);
    };
    async function stream() {
      try {
        const query = new URLSearchParams({ projectId, after: String(cursor) });
        const response = await fetch(`/v1/agents/${encodeURIComponent(agentId)}/feed?${query}`, {
          headers: { ...headers, Accept: "text/event-stream" },
          signal,
        });
        if (signal.aborted) {
          await response.body?.cancel().catch(() => {});
          return;
        }
        if (!response.ok || response.body === null) {
          await response.body?.cancel().catch(() => {});
          setUnavailable(true);
          if (response.status === 429 || response.status >= 500)
            throw new Error("Feed unavailable");
          return;
        }
        setUnavailable(false);
        for await (const raw of readSseFrames(response.body, signal)) {
          if (signal.aborted) return;
          if (raw.event === "resnapshot") {
            generation++;
            bodyController.abort();
            bodyController = new AbortController();
            queue.length = 0;
            requested.clear();
            for (const timer of evidenceRetries) clearTimeout(timer);
            evidenceRetries.clear();
            cursor = 0;
            clearTimeout(flushTimer);
            flushTimer = undefined;
            list = [];
            index = new Map();
            bodies.clear();
            wanted.clear();
            gone = new Set();
            dirty = { calls: false, bodies: false, gone: false };
            setCalls([]);
            setBodyVersion((old) => old + 1);
            setEvicted(new Set());
            break;
          }
          if (raw.event !== "toolcall") continue;
          const id = Number(raw.id);
          if (!Number.isSafeInteger(id) || id <= cursor) continue;
          let data: ToolCallFrame;
          try {
            data = JSON.parse(raw.data ?? "null");
          } catch {
            continue;
          }
          if (
            data?.agentId !== agentId ||
            typeof data.toolCallId !== "string" ||
            !data.evidence ||
            !Array.isArray(data.filePaths) ||
            !data.filePaths.every((path) => typeof path === "string")
          )
            continue;
          cursor = id;
          const at = index.get(data.toolCallId);
          if (at === undefined) {
            index.set(data.toolCallId, list.length);
            list.push(data);
          } else list[at] = data;
          publish("calls");
        }
      } catch {
        if (!signal.aborted) setUnavailable(true);
      }
      if (!signal.aborted) retry = setTimeout(() => void stream(), 1000);
    }
    void stream();
    return () => {
      controller.abort();
      bodyController.abort();
      queue.length = 0;
      wanted.clear();
      requested.clear();
      bodies.clear();
      visibleReader.current = () => {};
      clearTimeout(retry);
      clearTimeout(flushTimer);
      for (const timer of evidenceRetries) clearTimeout(timer);
      evidenceRetries.clear();
    };
  }, [projectId, agentId, secret, bodies]);
  return (
    <>
      {unavailable ? <p role="status">Live feed unavailable.</p> : null}
      <LiveTab
        {...props}
        calls={calls}
        evidence={bodies.get}
        evicted={evicted}
        onVisibleCalls={onVisibleCalls}
      />
    </>
  );
}
