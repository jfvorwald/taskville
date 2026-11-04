import { defineConfig } from "./playwright.ts";

// M5.11 replay suite. No webServer: the spec starts its own `taskville serve --headless` in a
// throwaway home (harness.ts), which hosts the built client in apps/web/dist.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  timeout: 120_000,
  use: {
    browserName: "chromium",
    headless: true,
    launchOptions: {
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
});
