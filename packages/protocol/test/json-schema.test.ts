import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildJsonSchemas, EVENT_TYPES } from "../src/index.ts";

const script = join(import.meta.dirname, "..", "scripts", "export-json-schema.ts");
const outDir = mkdtempSync(join(tmpdir(), "taskville-protocol-schema-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

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
    const input = buildJsonSchemas()["input-event"] as {
      oneOf: { properties: { type: { const: string } } }[];
    };
    const types = input.oneOf.map((member) => member.properties.type.const);
    expect(types.sort()).toEqual([...EVENT_TYPES].sort());
    const status = input.oneOf.find((m) => m.properties.type.const === "task.status_changed");
    expect(JSON.stringify(status)).toContain('"sourceValue"');
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
