import { useCallback, useEffect, useRef, useState } from "react";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { useCurrentProjectId } from "../../../data/project.ts";
import { readSseFrames } from "../../../data/sse.ts";
import { SESSION_HEADER } from "../../../pairing/pair.ts";
import { useSession } from "../../../pairing/session.tsx";
import { FilesTab, type FilesTabProps, isEdit } from "./FilesTab.tsx";

/** Only the default Files slot owns transport; injected tabs remain controlled. */
export function ConnectedFilesTab({ agentId }: { agentId: string }) {
  const projectId = useCurrentProjectId();
  const secret = useSession();
  return (
    <SelectedFiles key={JSON.stringify([projectId, agentId])} {...{ projectId, agentId, secret }} />
  );
}

function SelectedFiles({
  projectId,
  agentId,
  secret,
}: {
  projectId: string;
  agentId: string;
  secret: string;
}) {
  const [frames, setFrames] = useState<FilesTabProps["frames"]>([]);
  const [evidence, setEvidence] = useState<Record<string, EvidenceResponse>>({});
  const [unavailable, setUnavailable] = useState(false);

  const selectionReader = useRef<NonNullable<FilesTabProps["onSelectionChange"]>>(() => {});
  const onSelectionChange = useCallback<NonNullable<FilesTabProps["onSelectionChange"]>>(
    (path, calls) => selectionReader.current(path, calls),
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const headers = { [SESSION_HEADER]: secret };
    const requested = new Set<string>();
    const evidenceRetries = new Set<ReturnType<typeof setTimeout>>();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    let generation = 0;

    let selectedPath: string | null = null;
    let evidenceController = new AbortController();
    let active = 0;
    const queue: (() => Promise<void>)[] = [];

    function resetEvidence() {
      generation += 1;
      evidenceController.abort();
      evidenceController = new AbortController();
      queue.length = 0;
      requested.clear();
      for (const timer of evidenceRetries) clearTimeout(timer);
      evidenceRetries.clear();
      setEvidence({});
    }

    function drain() {
      while (!signal.aborted && active < 4 && queue.length > 0) {
        const read = queue.shift();
        if (!read) break;
        active += 1;
        void read().finally(() => {
          active -= 1;
          drain();
        });
      }
    }

    selectionReader.current = (path, calls) => {
      if (signal.aborted) return;
      if (path !== selectedPath) {
        resetEvidence();
        selectedPath = path;
      }
      if (path === null) return;
      for (const call of calls) {
        if (!isEdit(call)) continue;
        readEvidence(call);
      }
      drain();
    };

    function readEvidence(call: ToolCallFrame) {
      const started = generation;
      const bodySignal = evidenceController.signal;
      const obsolete = () => signal.aborted || bodySignal.aborted || started !== generation;
      for (const part of ["input", "output"] as const) {
        const ref = call.evidence[part];
        if (ref?.status !== "stored") continue;
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
            if (obsolete()) return;
            if (
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
            // Missing evidence stays honestly "not reported"; never log credentials or bodies.
          }
        };
        queue.push(() => read(0));
      }
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
            resetEvidence();
            selectedPath = null;
            cursor = 0;
            setFrames([]);
            break;
          }
          if (raw.event !== "toolcall") continue;
          const id = Number(raw.id);
          const data: ToolCallFrame = JSON.parse(raw.data ?? "null");
          if (!Number.isSafeInteger(id) || id <= cursor || data?.agentId !== agentId) continue;
          if (
            !Array.isArray(data.filePaths) ||
            !data.filePaths.every((path) => typeof path === "string") ||
            typeof data.toolCallId !== "string" ||
            (data.toolName !== undefined && typeof data.toolName !== "string") ||
            !data.evidence
          )
            throw new Error("Invalid feed frame");
          cursor = id;
          setFrames((old) => [...old, { id, data }]);
        }
      } catch {
        if (!signal.aborted) setUnavailable(true);
      }
      if (!signal.aborted) retry = setTimeout(() => void stream(), 1000);
    }
    void stream();
    return () => {
      controller.abort();
      evidenceController.abort();
      queue.length = 0;
      clearTimeout(retry);
      for (const timer of evidenceRetries) clearTimeout(timer);
    };
  }, [projectId, agentId, secret]);

  return (
    <>
      {unavailable ? <p role="status">Files feed unavailable.</p> : null}
      <FilesTab
        agentId={agentId}
        frames={frames}
        evidence={evidence}
        onSelectionChange={onSelectionChange}
      />
    </>
  );
}
