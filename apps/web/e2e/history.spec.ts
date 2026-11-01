import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { type InputEventWire, inputEventSchema } from "../../../packages/protocol/src/envelope.ts";
import { CODES_FILE } from "./codes.ts";

// M6.03: real recorded states must replace the presentation during history, without
// losing events arriving live. No fixture scene, controller double, or command route.
test("clock entry scrubs recorded history and Esc/H/L restore the latest live city", async ({
  page,
  request,
}) => {
  const { web, home } = JSON.parse(readFileSync(CODES_FILE, "utf8")) as {
    web: string;
    home: string;
  };
  // `web` is an existing valid code, still outstanding for this isolated spec run.
  const producerHeaders = {
    Authorization: `Bearer ${readFileSync(join(home, "token"), "utf8").trim()}`,
  };
  const timeline = "/v1/timelines/live%3Aunsorted";
  const agentId = "history-recorder";
  let sequence = 0;
  async function record(type: InputEventWire["type"], payload: unknown) {
    const event = inputEventSchema.parse({
      schemaVersion: 1,
      projectId: "unsorted",
      sourceId: "history-e2e",
      sourceEventId: `history-${++sequence}`,
      occurredAt: new Date(Date.now() - 1_000).toISOString(),
      provenance: "live",
      agentId,
      type,
      payload,
    });
    const response = await request.post("/v1/events/batch", {
      headers: producerHeaders,
      data: { events: [event] },
    });
    expect(response.status()).toBe(200);
    expect((await response.json()).results).toMatchObject([{ status: "accepted" }]);
  }

  await page.goto(`/#pair=${web}`);
  await expect(page.getByTestId("scene-root")).toBeVisible();
  await expect(page.getByTestId("overlay-root")).toContainText("paired");
  const session = await page.evaluate(() => localStorage.getItem("taskville.session"));
  expect(session).toBeTruthy();
  const readerHeaders = { "X-Taskville-Session": session ?? "" };
  const timelines = await request.get("/v1/projects/unsorted/timelines", {
    headers: readerHeaders,
  });
  expect(timelines.status()).toBe(200);
  const { firstAt } = (await timelines.json()).timelines[0];
  // The first recorded position predates this agent. Use receivedAt, never occurredAt.
  await expect.poll(() => Date.now() > Date.parse(firstAt)).toBe(true);
  await record("agent.registered", {
    sourceAgentId: agentId,
    displayName: "Recorder",
    role: "developer",
    kind: "session",
  });
  await record("agent.connected", {});
  await record("activity.started", { activity: "testing" });
  const agents = page.getByRole("grid", { name: "Agents", exact: true });
  const recorder = agents.getByRole("row", { name: /Recorder/ });
  await expect(recorder).toContainText("Testing");

  // Prove the engine reconstructs the earlier position before testing the missing UI.
  const early = await request.get(`${timeline}/state?at=${encodeURIComponent(firstAt)}`, {
    headers: readerHeaders,
  });
  expect(early.status()).toBe(200);
  expect((await early.json()).state.agents[agentId]).toBeUndefined();

  // Intended RED on the M6.02 base: the header has no clock/history entry yet.
  await page.getByRole("button", { name: /history/i }).click({ timeout: 5_000 });
  const chip = page.getByText(/^HISTORY\s*·\s*\S+/);
  await expect(chip).toBeVisible();
  const scrubber = page.getByRole("slider", { name: /history|timeline|time/i });
  await expect(scrubber).toBeVisible();
  // Keyboard scrubbing avoids assuming a pixel layout or an internal slider value scale.
  await scrubber.focus();
  await page.keyboard.press("Home");
  await expect(recorder).toHaveCount(0);
  await page.keyboard.press("End");
  await expect(recorder).toContainText("Testing");

  // The recording grows while the historical view stays at its chosen position.
  await record("activity.started", { activity: "documenting" });
  const latest = await request.get("/v1/projects/unsorted/snapshot", { headers: readerHeaders });
  expect(latest.status()).toBe(200);
  expect((await latest.json()).state.activity[agentId].activity).toBe("documenting");
  await expect(recorder).toContainText("Testing");
  await expect(chip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chip).toHaveCount(0);
  await expect(scrubber).toHaveCount(0);
  await expect(recorder).toContainText("Documenting");

  // Re-enter from the unfocused page, then leave with the other documented shortcut.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("h");
  await expect(chip).toBeVisible();
  await page.keyboard.press("l");
  await expect(chip).toHaveCount(0);
  await expect(recorder).toContainText("Documenting");
});
