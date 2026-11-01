import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AttentionChips } from "./attentionChips.tsx";

// M4.01: the header names each other project that needs you and switches to it on click.
// `onSwitch` receives the project ID; the caller owns how the app changes project.

describe("AttentionChips", () => {
  it("names each other project with its needs-you count", async () => {
    await render(
      <AttentionChips
        otherProjects={[
          { projectId: "beta", name: "Beta", needsYou: 2 },
          { projectId: "gamma", name: "Gamma", needsYou: 1 },
        ]}
        onSwitch={() => {}}
      />,
    );
    await expect.element(page.getByRole("button", { name: "Beta: 2 need you" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Gamma: 1 needs you" })).toBeVisible();
  });

  it("switches to the project when its chip is clicked", async () => {
    const onSwitch = vi.fn();
    await render(
      <AttentionChips
        otherProjects={[
          { projectId: "beta", name: "Beta", needsYou: 2 },
          { projectId: "gamma", name: "Gamma", needsYou: 1 },
        ]}
        onSwitch={onSwitch}
      />,
    );
    await page.getByRole("button", { name: "Gamma: 1 needs you" }).click();
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch).toHaveBeenCalledWith("gamma");
  });

  it("renders nothing when no other project needs you", async () => {
    const screen = await render(<AttentionChips otherProjects={[]} onSwitch={() => {}} />);
    expect(screen.container.textContent).toBe("");
    expect(screen.container.querySelector("button")).toBeNull();
  });
});
