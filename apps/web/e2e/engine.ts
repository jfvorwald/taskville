import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeServe } from "../../cli/src/commands/serve.ts";
import { startServer } from "../../engine/src/http/server.ts";
import { CODES_FILE } from "./codes.ts";

// The e2e engine: the same composition as `taskville serve --headless` (routes, auth, static
// hosting of apps/web/dist), on a fixed port with a throwaway home. The one-time pairing codes
// are issued in-process, exactly as `serve` does, and written to a file for the tests to read;
// the engine has no route that mints a code.
const port = Number(process.env.E2E_PORT ?? 4817);
const home = mkdtempSync(join(tmpdir(), "taskville-e2e-"));

const parts = composeServe(
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: {},
    cwd: home,
  },
  home,
  port,
);
mkdirSync(dirname(CODES_FILE), { recursive: true });
writeFileSync(
  CODES_FILE,
  // `home` lets a test run CLI producers (`taskville demo start --home`) against this engine.
  JSON.stringify({
    paired: parts.pairing.issueCode(),
    fresh: parts.pairing.issueCode(),
    interaction: parts.pairing.issueCode(),
    celebrations: parts.pairing.issueCode(),
    accessibility: parts.pairing.issueCode(),
    movement: parts.pairing.issueCode(),
    lighting: parts.pairing.issueCode(),
    home,
  }),
);
const server = await startServer({ app: parts.app, port });
process.stdout.write(`e2e engine listening on http://127.0.0.1:${server.port}\n`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await parts.close();
  await server.close().catch(() => {});
  rmSync(home, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
