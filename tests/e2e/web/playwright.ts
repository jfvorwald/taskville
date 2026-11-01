// The one place tests/e2e/web finds Playwright. It is a dependency of apps/web only (pnpm does
// not hoist it to the root), so the specs and the measurement script import it from here. If the
// root package.json ever gains @playwright/test and playwright, replace this file with plain
// `export * from "@playwright/test"` and `export { chromium } from "playwright"`.
export * from "../../../apps/web/node_modules/@playwright/test/index.mjs";
export { chromium } from "../../../apps/web/node_modules/playwright/index.mjs";
