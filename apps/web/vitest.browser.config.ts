import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Component tests that need a real browser (React Aria, R3F). Run with
// `pnpm --filter @taskville/web test:browser`. Not part of `pnpm check`: it needs Chromium
// (`pnpm exec playwright install chromium`) and the check gate must stay fast and browser-free.
export default defineConfig({
  plugins: [react()],
  test: {
    name: "@taskville/web-browser",
    include: ["src/**/*.browser.test.tsx"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
