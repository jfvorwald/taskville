import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { CODES_FILE } from "./codes.ts";

// M3.01 smoke: a paired page loads the city; an unpaired page is refused data.

const codes = (): { paired: string; fresh: string } => JSON.parse(readFileSync(CODES_FILE, "utf8"));

test("a paired page loads the scene, clears the fragment, and keeps the session across reloads", async ({
  page,
}) => {
  const { paired } = codes();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  await page.goto(`/#pair=${paired}`);
  await expect(page.getByTestId("scene-root")).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.getByTestId("overlay-root")).toContainText("paired");
  // Task reports attach a screenshot: E2E_SCREENSHOT=docs/tasks/M3.01/paired.png pnpm ... test:e2e
  if (process.env.E2E_SCREENSHOT) {
    await page.waitForTimeout(1000); // let the first WebGL frames draw
    await page.screenshot({ path: process.env.E2E_SCREENSHOT });
  }

  // The code left the address bar, and never travelled in a URL.
  expect(new URL(page.url()).hash).toBe("");
  expect(requests.some((url) => url.includes(paired))).toBe(false);

  const secret = await page.evaluate(() => localStorage.getItem("taskville.session"));
  expect(secret).toMatch(/^[A-Za-z0-9_-]{20,}$/);

  // The stored session carries the page past a reload with no fragment.
  await page.reload();
  await expect(page.getByTestId("scene-root")).toBeVisible();

  // And it is accepted by the engine: the same call with it succeeds, without it is refused.
  const withSession = await page.evaluate(async (session) => {
    const res = await fetch("/health", { headers: { "X-Taskville-Session": session ?? "" } });
    return res.status;
  }, secret);
  expect(withSession).toBe(200);
});

test("an unpaired page is refused data and shows how to pair", async ({ page }) => {
  const responses: { url: string; status: number }[] = [];
  page.on("response", (response) =>
    responses.push({ url: new URL(response.url()).pathname, status: response.status() }),
  );

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Not paired" })).toBeVisible();
  await expect(page.getByTestId("scene-root")).toHaveCount(0);
  await expect(page.locator("canvas")).toHaveCount(0);
  // The page itself never asked the API for anything (checked before this test probes it).
  const ownApiCalls = responses.filter((r) => r.url.startsWith("/v1") || r.url === "/health");
  expect(ownApiCalls).toEqual([]);

  // The page itself is public, the API is not.
  const refused = await page.evaluate(async () => {
    const out: Record<string, number> = {};
    for (const path of ["/health", "/v1/projects", "/v1/projects/unsorted/snapshot"]) {
      out[path] = (await fetch(path)).status;
    }
    return out;
  });
  expect(refused).toEqual({
    "/health": 401,
    "/v1/projects": 401,
    "/v1/projects/unsorted/snapshot": 401,
  });
});

test("a wrong link is refused and cleared, then a fresh link pasted in the same tab pairs", async ({
  page,
}) => {
  await page.goto("/#pair=not-a-real-code");
  await expect(page.getByRole("heading", { name: "Pairing link not accepted" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  expect(await page.evaluate(() => localStorage.getItem("taskville.session"))).toBeNull();

  // Only the fragment changes, so the page does not reload; it must pair anyway.
  const { fresh } = codes();
  await page.evaluate((code) => {
    location.hash = `#pair=${code}`;
  }, fresh);
  await expect(page.getByTestId("scene-root")).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
});
