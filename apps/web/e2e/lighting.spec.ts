import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { CODES_FILE } from "./codes.ts";

// M3.12: the city's lighting follows the browser's clock. The browser runs in UTC with a fixed
// clock, so the hour is known. Screenshots land in E2E_SCREENSHOT_DIR (docs/tasks/M3.12/).

test.use({ timezoneId: "UTC" });

const codes = (): { paired: string } => JSON.parse(readFileSync(CODES_FILE, "utf8"));

const cases = [
  { name: "noon", at: "2026-10-31T12:00:00Z", mode: "day" },
  { name: "dusk", at: "2026-10-31T18:45:00Z", mode: "night" },
  { name: "night", at: "2026-10-31T23:30:00Z", mode: "night" },
] as const;

test("day, dusk and night lighting from the browser clock", async ({ page, browser }) => {
  // The pairing code is one-time: pair once, then reload at each time on the stored session.
  await page.clock.setFixedTime(new Date(cases[0].at));
  await page.goto(`/#pair=${codes().paired}`);
  for (const c of cases) {
    await page.clock.setFixedTime(new Date(c.at));
    await page.reload();
    await expect(page.locator("canvas")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-mode", c.mode);
    const dir = process.env.E2E_SCREENSHOT_DIR;
    if (dir) {
      await page.waitForTimeout(1500); // let the first WebGL frames draw
      await page.screenshot({ path: `${dir}/${c.name}.png` });
    }
  }

  // The browser's own zone: the controller has no injected zone here, so it reads the browser's.
  // 12:00Z is noon in UTC (day, above) but 21:00 in Tokyo, so the same instant is night there.
  // The session is reused from the paired page (the pairing code is one-time).
  const tokyo = await browser.newContext({
    timezoneId: "Asia/Tokyo",
    storageState: await page.context().storageState(),
  });
  try {
    const tokyoPage = await tokyo.newPage();
    await tokyoPage.clock.setFixedTime(new Date("2026-10-31T12:00:00Z"));
    await tokyoPage.goto(new URL("/", page.url()).href); // newContext does not inherit baseURL
    await expect(tokyoPage.locator("canvas")).toBeVisible();
    await expect(tokyoPage.locator("html")).toHaveAttribute("data-mode", "night");
  } finally {
    await tokyo.close();
  }
});
