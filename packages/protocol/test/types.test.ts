import { describe, expectTypeOf, it } from "vitest";
import type {
  AgentKind,
  EventType,
  IngestResult,
  InputEvent,
  InputEventOf,
  InputEventWire,
  InputPayload,
  StoredEnvelope,
  StoredEnvelopeOf,
  StoredPayload,
  StoredReason,
  TaskStatus,
} from "../src/index.ts";

// Checked by `tsc` in `pnpm check`; these pin the exported types other packages build on.
describe("exported types", () => {
  it("narrows events by type", () => {
    expectTypeOf<InputEvent["type"]>().toEqualTypeOf<EventType>();
    expectTypeOf<StoredEnvelope["type"]>().toEqualTypeOf<EventType>();
    expectTypeOf<
      InputEventOf<"task.status_changed">["payload"]["status"]
    >().toEqualTypeOf<TaskStatus>();
    expectTypeOf<
      StoredEnvelopeOf<"agent.registered">["payload"]["kind"]
    >().toEqualTypeOf<AgentKind>();
    expectTypeOf<StoredEnvelopeOf<"git.merge">["ingestSequence"]>().toEqualTypeOf<number>();
  });

  it("keeps reason as text on input and as the stored object after", () => {
    expectTypeOf<InputPayload<"command.failed">["reason"]>().toEqualTypeOf<string>();
    expectTypeOf<StoredPayload<"command.failed">["reason"]>().toEqualTypeOf<StoredReason>();
  });

  it("lets producers write events without defaults and with any open enum string", () => {
    expectTypeOf<{
      schemaVersion: 1;
      projectId: string;
      sourceId: string;
      sourceEventId: string;
      occurredAt: string;
      type: "task.status_changed";
      taskId: string;
      payload: { status: string };
      provenance: "live";
    }>().toExtend<InputEventWire>();
  });

  it("discriminates ingest results on status", () => {
    expectTypeOf<
      Extract<IngestResult, { status: "conflict" }>["existingEventId"]
    >().toEqualTypeOf<string>();
  });
});
