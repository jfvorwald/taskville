import { useEffect, useMemo, useState } from "react";
import { Button } from "react-aria-components";
import type { EvidenceRef, EvidenceResponse } from "../../../../../engine/src/feed/evidence.ts";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import styles from "./files.module.css";

export interface FilesTabProps {
  agentId: string;
  frames: readonly { id: number; data: ToolCallFrame }[];
  evidence?: Readonly<Record<string, EvidenceResponse>>;
  onSelectionChange?: (path: string | null, calls: readonly ToolCallFrame[]) => void;
}

interface RecordedCall {
  first: number;
  latest: number;
  data: ToolCallFrame;
  paths: Set<string>;
}

const isEdit = (call: ToolCallFrame) => call.toolName === "Edit" || call.toolName === "Write";

/** Fold updates without letting a completion or redelivery change a call's recorded order. */
function filesFor(agentId: string, frames: FilesTabProps["frames"]) {
  const calls = new Map<string, RecordedCall>();
  for (const { id, data } of frames) {
    if (data.agentId !== agentId) continue;
    const call = calls.get(data.toolCallId);
    if (call === undefined) {
      calls.set(data.toolCallId, {
        first: id,
        latest: id,
        data,
        paths: new Set(data.filePaths),
      });
    } else {
      call.first = Math.min(call.first, id);
      for (const path of data.filePaths) call.paths.add(path);
      if (id > call.latest) {
        call.latest = id;
        call.data = data;
      }
    }
  }
  const files = new Map<string, { path: string; newest: number; edits: RecordedCall[] }>();
  for (const call of [...calls.values()].sort((a, b) => a.first - b.first)) {
    for (const path of call.paths) {
      let file = files.get(path);
      if (file === undefined) {
        file = { path, newest: call.first, edits: [] };
        files.set(path, file);
      }
      file.newest = Math.max(file.newest, call.first);
      if (isEdit(call.data)) file.edits.push(call);
    }
  }
  return [...files.values()].sort((a, b) => b.newest - a.newest);
}

function EvidenceBody({
  reference,
  evidence,
}: {
  reference: EvidenceRef | null;
  evidence: FilesTabProps["evidence"];
}) {
  const body =
    reference?.status === "stored" && evidence && Object.hasOwn(evidence, reference.id)
      ? evidence[reference.id]
      : undefined;
  return (
    <>
      <pre className={styles.body}>{body?.text ?? "not reported"}</pre>
      {body?.truncated ? <p>Recorded excerpt truncated</p> : null}
    </>
  );
}

/** Agent IDs include the session identity; changing agents also discards open file detail. */
export function FilesTab(props: FilesTabProps) {
  return <AgentFiles key={props.agentId} {...props} />;
}

function AgentFiles({ agentId, frames, evidence, onSelectionChange }: FilesTabProps) {
  const files = useMemo(() => filesFor(agentId, frames), [agentId, frames]);
  const [selected, setSelected] = useState<string | null>(null);
  const file = files.find((item) => item.path === selected);
  useEffect(() => {
    if (file === undefined) setSelected(null);
  }, [file]);

  useEffect(() => {
    onSelectionChange?.(file?.path ?? null, file?.edits.map((call) => call.data) ?? []);
  }, [file, onSelectionChange]);

  if (files.length === 0) return <p>No files reported for this agent.</p>;

  return (
    <div className={styles.files}>
      <ul className={styles.list} aria-label="Files touched this session">
        {files.map((item) => {
          const count = item.edits.filter((call) => call.data.phase === "succeeded").length;
          return (
            <li key={item.path}>
              <Button
                className={styles.row}
                data-testid="file-row"
                data-file-path={item.path}
                data-edit-count={count}
                aria-pressed={item.path === selected}
                onPress={() => setSelected(item.path)}
              >
                <span>{item.path}</span>
                <span>
                  {count} {count === 1 ? "edit" : "edits"}
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
      {file === undefined ? null : (
        <section
          data-testid="file-edits"
          data-file-path={file.path}
          aria-label={`Edits to ${file.path}`}
        >
          <h3 className={styles.path}>{file.path}</h3>
          {file.edits.length === 0 ? <p>No edits reported.</p> : null}
          {file.edits.map(({ data }) => (
            <article key={data.toolCallId} data-tool-call-id={data.toolCallId}>
              <h4>
                {data.toolName}: {data.phase}
              </h4>
              <p>Input</p>
              <EvidenceBody reference={data.evidence.input} evidence={evidence} />
              <p>Output</p>
              <EvidenceBody reference={data.evidence.output} evidence={evidence} />
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
