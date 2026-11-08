import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CODES_FILE } from "./codes.ts";

// M8.03: open an archive in history, scrub, return to live. Seeding is through the real engine:
// the spec creates a project whose only root is a throwaway Git fixture repo (POST /v1/projects,
// CLI token), then imports it (POST /v1/imports kind git) and waits for the job to finish. No
// change to e2e/engine.ts is needed. It stays red until the Git importer is registered (M8.11)
// and the picker exists (M8.03); the pairing code `web` is reused as history.spec.ts does.
const PROJECT = "archive-e2e";
const LABEL = /archive e2e|taskville|git/i;

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    stdio: "ignore",
  });
}

function fixtureRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "taskville-archive-e2e-")));
  git(root, "init", "-q", "-b", "main");
  for (const [index, name] of ["one", "two", "three"].entries()) {
    writeFileSync(join(root, `${name}.txt`), `${name}\n`);
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", `Add ${name} ${index}`);
  }
  return root;
}

test("opening an archive in history, scrubbing it and returning to live", async ({
  page,
  request,
}) => {
  const { web, home } = JSON.parse(readFileSync(CODES_FILE, "utf8")) as {
    web: string;
    home: string;
  };
  const cli = { Authorization: `Bearer ${readFileSync(join(home, "token"), "utf8").trim()}` };
  const repo = fixtureRepo();

  const created = await request.post("/v1/projects", {
    headers: cli,
    data: { id: PROJECT, name: "Archive e2e", roots: [repo] },
  });
  expect(created.status()).toBe(201);
  const started = await request.post("/v1/imports", {
    headers: cli,
    data: { projectId: PROJECT, kind: "git", root: repo },
  });
  expect(started.status()).toBe(202);
  const { importId, archiveId } = await started.json();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/v1/imports/${importId}`, { headers: cli })).json()).status,
      { timeout: 30_000 },
    )
    .toBe("done");

  await page.goto(`/#pair=${web}`);
  await expect(page.getByTestId("scene-root")).toBeVisible();
  await expect(page.getByTestId("overlay-root")).toContainText("paired");
  await page.getByRole("combobox", { name: "Project", exact: true }).selectOption(PROJECT);

  await page.getByRole("button", { name: /history/i }).click({ timeout: 5_000 });
  const picker = page.getByRole("combobox", { name: "Timeline", exact: true });
  await expect(picker).toBeVisible();
  const options = await picker.locator("option").allTextContents();
  expect(options[0]).toMatch(/^Live recording/);
  expect(options.some((text) => LABEL.test(text) && /\bgit\b/i.test(text))).toBe(true);

  await picker.selectOption({ index: options.findIndex((text) => /\bgit\b/i.test(text)) });
  await expect(page.getByText("Git", { exact: true })).toBeVisible();
  await expect(page.getByText(/^HISTORY\s*·/)).toBeVisible();
  const timelineState = await request.get(
    `/v1/timelines/${encodeURIComponent(`archive:${archiveId}`)}/state?at=1`,
    {
      headers: {
        "X-Taskville-Session":
          (await page.evaluate(() => localStorage.getItem("taskville.session"))) ?? "",
      },
    },
  );
  expect(timelineState.status()).toBe(200);

  const scrubber = page.getByRole("slider", { name: "Timeline time" });
  await expect(scrubber).toBeVisible();
  await scrubber.focus();
  // The slider is controlled: its value follows the seek read, so assert web-first (poll).
  await page.keyboard.press("End");
  await expect.poll(async () => Number(await scrubber.inputValue())).toBeGreaterThanOrEqual(3);
  await page.keyboard.press("Home");
  await expect(scrubber).toHaveValue("1");
  await expect(page.getByRole("row")).toHaveCount(0); // a Git archive shows no agents
  await expect(page.locator('[data-marker="Git commit"]').first()).toBeVisible();

  await page.getByRole("button", { name: /^Back to live\b/i }).click();
  await expect(page.getByText(/^HISTORY\s*·/)).toHaveCount(0);
  await expect(scrubber).toHaveCount(0);
  await expect(picker).toHaveCount(0);
});
