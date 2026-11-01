import { mapClaudeCodeHook } from "../../../../../../packages/adapters/src/claude-code/index.ts";
import recordedTasks from "../../../../../../packages/adapters/test/claude-code/crew/team-task.fixture.jsonl?raw";
import { storedEnvelopeSchema } from "../../../../../../packages/protocol/src/index.ts";
import { initialState, reduce, type StoredEnvelope } from "../../../../src/data/domain.ts";
import { AT, PROJECT } from "./integration.fixture.ts";

export { PROJECT };
export const TEAM = "claude-code:team:session-b4395a96";
export const TASK = "claude-code:task:session-b4395a96:1";
export const LEAD = "claude-code:b4395a96-fd40-4c5f-8ea3-c5f447a2e4a7";
export const MEMBER = `${LEAD}:apip-c669c6801b38dd2a`;
export const OTHER = `${LEAD}:other-member`;

export function completionScenario() {
  let sequence = 0;
  const stored = (event: Record<string, unknown>): StoredEnvelope => {
    sequence++;
    return storedEnvelopeSchema.parse({
      schemaVersion: 1,
      projectId: PROJECT,
      sourceId: "claude-code",
      sourceEventId: `completion-${sequence}`,
      occurredAt: AT,
      evidenceIds: [],
      provenance: "live",
      late: false,
      ...event,
      eventId: `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`,
      receivedAt: AT,
      ingestSequence: sequence,
    });
  };
  // Only team membership is scaffolded. Task creation and completion below use the
  // same recorded M2.20 hooks as the M5.16 adapter-to-domain regression.
  const setup = [
    ...[
      [LEAD, "lead", "lead"],
      [MEMBER, "teammate", "pip"],
      [OTHER, "teammate", "bo"],
    ].map(([id, kind, name]) =>
      stored({
        type: "agent.registered",
        agentId: id,
        payload: { sourceAgentId: id, kind, displayName: name, teamId: TEAM, role: "dev" },
      }),
    ),
    stored({ type: "team.started", agentId: LEAD, payload: { teamId: TEAM, leadAgentId: LEAD } }),
  ];
  const tasks = recordedTasks
    .trim()
    .split("\n")
    .flatMap((line) => {
      const hook = JSON.parse(line) as { seq: number; input: Record<string, unknown> };
      return mapClaudeCodeHook(hook.input, {
        projectId: PROJECT,
        sourceEventId: `recorded-${hook.seq}`,
        receivedAt: AT,
        late: false,
      }).events.map((event) => stored(event));
    });
  const [created, completed] = tasks;
  if (!created || !completed || tasks.length !== 2)
    throw new Error("Expected two recorded task events");
  return {
    tasks,
    completed,
    state: [...setup, created].reduce(reduce, initialState(PROJECT)),
    status: (status: "queued" | "completed") =>
      stored({ type: "task.status_changed", taskId: TASK, payload: { status } }),
  };
}
