import { describe, expect, it } from "vitest";
import { redactText } from "../src/redact/index.ts";

// M7.16 (#393), M7.12 lows that are worth fixing. Fake secrets are assembled at runtime so no
// secret-shaped literal sits in the source. Closed instead (decision #223 accepted limits): L3
// shell-grammar obfuscation and L5 YAML name/value pairs and double-encoded JSON.

const pw = ["s3", "cr3t", "pa", "ss"].join("");

describe("M7.12 L4: other registry CLIs", () => {
  it.each([
    ["helm registry login -p", `helm registry login reg.example -u me -p ${pw}`],
    ["oras login -p", `oras login reg.example -u me -p ${pw}`],
    ["skopeo login -p", `skopeo login reg.example -u me -p ${pw}`],
    ["crane auth login -p", `crane auth login reg.example -u me -p ${pw}`],
    ["buildah login -p", `buildah login -u me -p ${pw} reg.example`],
    ["docker.exe login -p", `docker.exe login -u me -p ${pw} reg.example`],
  ])("masks %s", (_name, input) => {
    const result = redactText(input);
    expect(result.text).not.toContain(pw);
    expect(result.spans.length).toBeGreaterThan(0);
  });

  it("leaves a harmless helm command alone", () => {
    const input = "helm registry logout reg.example";
    expect(redactText(input).text).toBe(input);
  });
});
