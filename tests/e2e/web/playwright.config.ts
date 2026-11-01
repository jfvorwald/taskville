import { fileURLToPath } from "node:url";
import { defineConfig } from "./playwright.ts";

// The root-level web smoke suite (M3.16). It reuses the web e2e engine (apps/web/e2e/engine.ts:
// `composeServe` on a fixed port, a throwaway home, one-time pairing codes in a file) as its
// webServer, so it needs the built client in apps/web/dist. Run it with the commands in README.md.
const port = Number(process.env.E2E_PORT ?? 4886);
const web = fileURLToPath(new URL("../../../apps/web", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    headless: true,
    launchOptions: {
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command: "node e2e/engine.ts",
    cwd: web,
    url: `http://127.0.0.1:${port}/`,
    // The engine issues the pairing code named by E2E_SPEC last, so it always survives (it keeps
    // at most five). Both the spec and measure.ts use the code named `web`.
    env: { E2E_PORT: String(port), E2E_SPEC: "web" },
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
