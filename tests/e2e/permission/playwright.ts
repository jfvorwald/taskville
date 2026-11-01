// The one place tests/e2e/permission finds Playwright (a dependency of apps/web only; see
// tests/e2e/web/playwright.ts, which this re-exports).
export * from "../web/playwright.ts";
