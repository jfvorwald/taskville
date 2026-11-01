import { Component, type ReactNode, useEffect, useState } from "react";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { useCurrentProjectId } from "../../../data/project.ts";
import { readSseFrames } from "../../../data/sse.ts";
import { SESSION_HEADER } from "../../../pairing/pair.ts";
import { useSession } from "../../../pairing/session.tsx";
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
      key={JSON.stringify([projectId, props.agentId, secret])}
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
  const [evidence, setEvidence] = useState<Record<string, EvidenceResponse>>({});
  const [unavailable, setUnavailable] = useState(false);
  const { agentId } = props;
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const headers = { [SESSION_HEADER]: secret };
    let bodyController = new AbortController();
    let generation = 0;
    let active = 0;
    let cursor = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const requested = new Set<string>();
    const evidenceRetries = new Set<ReturnType<typeof setTimeout>>();
    const queue: (() => Promise<void>)[] = [];
    function drain() {
      while (!signal.aborted && active < 4 && queue.length) {
        const read = queue.shift();
        if (!read) break;
        active++;
        void read().finally(() => {
          active--;
          drain();
        });
      }
    }
    function readEvidence(call: ToolCallFrame) {
      const started = generation;
      const bodySignal = bodyController.signal;
      const obsolete = () => signal.aborted || bodySignal.aborted || started !== generation;
      for (const part of ["input", "output"] as const) {
        const ref = call.evidence[part];
        if (ref?.status !== "stored" || typeof ref.id !== "string") continue;
        const key = JSON.stringify([ref.id, call.toolCallId, part]);
        if (requested.has(key)) continue;
        requested.add(key);
        const read = async (attempt: number): Promise<void> => {
          if (obsolete()) return;
          try {
            const response = await fetch(`/v1/evidence/${encodeURIComponent(ref.id)}`, {
              headers,
              signal: bodySignal,
            });
            if (obsolete()) return;
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
            setEvidence((old) => ({ ...old, [ref.id]: body }));
          } catch {
            if (obsolete()) return;
            if (attempt < 2) {
              const timer = setTimeout(
                () => {
                  evidenceRetries.delete(timer);
                  if (obsolete()) return;
                  queue.push(() => read(attempt + 1));
                  drain();
                },
                500 * 2 ** attempt,
              );
              evidenceRetries.add(timer);
            } else requested.delete(key);
            // Unavailable evidence remains not reported. Never log bodies or credentials.
          }
        };
        queue.push(() => read(0));
      }
      drain();
    }
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
            setCalls([]);
            setEvidence({});
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
          setCalls((old) => {
            const index = old.findIndex((call) => call.toolCallId === data.toolCallId);
            if (index < 0) return [...old, data];
            return old.map((call, i) => (i === index ? data : call));
          });
          readEvidence(data);
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
      clearTimeout(retry);
      for (const timer of evidenceRetries) clearTimeout(timer);
      evidenceRetries.clear();
    };
  }, [projectId, agentId, secret]);
  return (
    <>
      {unavailable ? <p role="status">Live feed unavailable.</p> : null}
      <LiveTab {...props} calls={calls} evidence={evidence} />
    </>
  );
}
