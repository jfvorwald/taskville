import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 4817);

// One real engine (`composeServe`, the same wiring as `taskville serve`) hosting the built web
// client from `dist`, with a throwaway home. Run with `pnpm --filter @taskville/web test:e2e`,
// which builds first. Chromium only: `pnpm exec playwright install chromium`.
export default defineConfig({
  testDir: "e2e",
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
    url: `http://127.0.0.1:${port}/`,
    env: { E2E_PORT: String(port), E2E_SPEC: process.env.E2E_SPEC ?? "" },
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
