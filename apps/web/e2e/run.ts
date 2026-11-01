import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

// Runs the e2e suite one spec file at a time, each against its own fresh engine.
//
// Each Playwright run starts `e2e/engine.ts` (the webServer in playwright.config.ts) with an
// empty home, so a spec never sees the agents another spec's demo produced, and the engine only
// has to hold the pairing codes that one spec uses (`taskville serve` keeps at most five).
// Arguments ending in `.spec.ts` pick the files; every other argument (for example `-g`) is
// passed to each run.
const args = process.argv.slice(2);
const named = args.filter((a) => a.endsWith(".spec.ts"));
const flags = args.filter((a) => !a.endsWith(".spec.ts"));
const specs =
  named.length > 0
    ? named
    : readdirSync(new URL(".", import.meta.url))
        .filter((name) => name.endsWith(".spec.ts"))
        .sort()
        .map((name) => `e2e/${name}`);

const failed: string[] = [];
for (const spec of specs) {
  const name = spec.replace(/^.*\//, "").replace(/\.spec\.ts$/, "");
  const run = spawnSync("playwright", ["test", spec, ...flags], {
    stdio: "inherit",
    env: { ...process.env, E2E_SPEC: name },
  });
  if (run.status !== 0) failed.push(spec);
}
if (failed.length > 0) {
  process.stderr.write(`e2e failed: ${failed.join(", ")}\n`);
  process.exit(1);
}
