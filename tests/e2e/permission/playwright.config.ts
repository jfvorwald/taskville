import { defineConfig } from "./playwright.ts";

// The M4.10 replay suite. Unlike tests/e2e/web, there is no webServer: each test starts its own
// `taskville serve --headless` (short hold window, throwaway home, see harness.ts), which hosts
// the built client in apps/web/dist. Run it with the commands in README.md.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  timeout: 60_000,
  use: {
    browserName: "chromium",
    headless: true,
    launchOptions: {
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
});
