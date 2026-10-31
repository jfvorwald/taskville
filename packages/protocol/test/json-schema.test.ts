import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exportJsonSchemas } from "../scripts/export-json-schema.ts";
import { buildJsonSchemas, EVENT_TYPES } from "../src/index.ts";

const script = join(import.meta.dirname, "..", "scripts", "export-json-schema.ts");
const outDir = mkdtempSync(join(tmpdir(), "taskville-protocol-schema-"));
const inProcessDir = mkdtempSync(join(tmpdir(), "taskville-protocol-schema-"));
afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
  rmSync(inProcessDir, { recursive: true, force: true });
});

type MemberSchema = { properties: { type: { const: string } } };

describe("JSON Schema export", () => {
  it("builds a schema per public document", () => {
    const schemas = buildJsonSchemas();
    expect(Object.keys(schemas).sort()).toEqual(
      [
        "input-event",
        "stored-envelope",
        "ingest-result",
        "event-batch-request",
        "event-batch-response",
        "api-error",
        "sse-frame",
      ].sort(),
    );
  });

  it("describes every event type in the input event schema, in wire (input) form", () => {
    const input = buildJsonSchemas()["input-event"] as unknown as { oneOf: MemberSchema[] };
    const types = input.oneOf.map((member) => member.properties.type.const);
    expect(types.sort()).toEqual([...EVENT_TYPES].sort());
    const status = input.oneOf.find((m) => m.properties.type.const === "task.status_changed");
    expect(JSON.stringify(status)).toContain('"sourceValue"');
  });

  it("lists the envelope IDs each type requires", () => {
    for (const name of ["input-event", "stored-envelope"] as const) {
      const doc = buildJsonSchemas()[name] as unknown as {
        oneOf: (MemberSchema & { required: string[] })[];
      };
      const required = (type: string) =>
        doc.oneOf.find((m) => m.properties.type.const === type)?.required ?? [];
      expect(required("session.started")).toEqual(expect.arrayContaining(["agentId", "sessionId"]));
      expect(required("task.created")).toContain("taskId");
      expect(required("git.commit")).not.toContain("agentId");
    }
  });

  it("lists required envelope IDs inside the SSE event frame too", () => {
    const text = JSON.stringify(buildJsonSchemas()["sse-frame"]);
    const member = /"type":\{"type":"string","const":"session\.started"\}/;
    expect(text).toMatch(member);
    const doc = buildJsonSchemas()["sse-frame"] as unknown as {
      oneOf: { properties: { data: { oneOf?: (MemberSchema & { required: string[] })[] } } }[];
    };
    const envelopes = doc.oneOf.flatMap((frame) => frame.properties.data.oneOf ?? []);
    const started = envelopes.find((m) => m.properties.type.const === "session.started");
    expect(started?.required).toEqual(expect.arrayContaining(["agentId", "sessionId"]));
  });

  it("states code-point limits as maxLength", () => {
    const input = JSON.stringify(buildJsonSchemas()["input-event"]);
    expect(input).toContain('"maxLength":4000');
    expect(input).toContain('"maxLength":2000');
    expect(JSON.stringify(buildJsonSchemas()["stored-envelope"])).toContain('"maxLength":280');
  });

  it("exports in process to the given directory", () => {
    const written = exportJsonSchemas(inProcessDir);
    expect(written).toHaveLength(Object.keys(buildJsonSchemas()).length);
    expect(readdirSync(inProcessDir)).toContain("input-event.schema.json");
  });

  it("exits with usage when no output directory is given", () => {
    expect(() => execFileSync(process.execPath, [script], { stdio: "pipe" })).toThrow(/Usage/);
  });

  it("runs as a script and writes one JSON file per schema", () => {
    const stdout = execFileSync(process.execPath, [script, outDir], { encoding: "utf8" });
    const files = readdirSync(outDir).sort();
    expect(files).toEqual(
      Object.keys(buildJsonSchemas())
        .map((n) => `${n}.schema.json`)
        .sort(),
    );
    for (const file of files) {
      const schema = JSON.parse(readFileSync(join(outDir, file), "utf8"));
      expect(schema.$schema).toContain("json-schema.org");
      expect(schema.$id).toBe(`urn:taskville:protocol:v1:${file.replace(".schema.json", "")}`);
    }
    expect(stdout).toContain(`${files.length} schemas`);
  });
});
