import { useEffect, useState } from "react";
import type { EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import { useCurrentProjectId } from "../../../data/project.ts";
import { readSseFrames } from "../../../data/sse.ts";
import { SESSION_HEADER } from "../../../pairing/pair.ts";
import { useSession } from "../../../pairing/session.tsx";
import { FilesTab, type FilesTabProps } from "./FilesTab.tsx";

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

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const headers = { [SESSION_HEADER]: secret };
    const requested = new Set<string>();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    let generation = 0;

    function readEvidence(call: ToolCallFrame) {
      const started = generation;
      for (const part of ["input", "output"] as const) {
        const ref = call.evidence[part];
        if (ref?.status !== "stored" || requested.has(ref.id)) continue;
        requested.add(ref.id);
        // Bodies are independent: a slow input must not block later frames or output reads.
        void (async () => {
          try {
            const response = await fetch(`/v1/evidence/${encodeURIComponent(ref.id)}`, {
              headers,
              signal,
            });
            if (!response.ok || signal.aborted) return;
            const body: EvidenceResponse = await response.json();
            if (signal.aborted || started !== generation) return;
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
            // Missing evidence stays honestly "not reported"; never log credentials or bodies.
          }
        })();
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
          return;
        }
        setUnavailable(false);
        for await (const raw of readSseFrames(response.body, signal)) {
          if (signal.aborted) return;
          if (raw.event === "resnapshot") {
            generation += 1;
            cursor = 0;
            requested.clear();
            setFrames([]);
            setEvidence({});
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
            typeof data.toolName !== "string" ||
            !data.evidence
          )
            throw new Error("Invalid feed frame");
          cursor = id;
          setFrames((old) => [...old, { id, data }]);
          if (data.toolName === "Edit" || data.toolName === "Write") void readEvidence(data);
        }
      } catch {
        if (!signal.aborted) setUnavailable(true);
      }
      if (!signal.aborted) retry = setTimeout(() => void stream(), 1000);
    }
    void stream();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [projectId, agentId, secret]);

  return (
    <>
      {unavailable ? <p role="status">Files feed unavailable.</p> : null}
      <FilesTab agentId={agentId} frames={frames} evidence={evidence} />
    </>
  );
}
