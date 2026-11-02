import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { LiveTab } from "../live/LiveTab.tsx";
import { AGENT, articles, build, paint, seedStore, slot } from "../live/liveKit.tsx";

// M5.09 red: the Hide code setting reaches the Live tab. Interface: LiveTab takes an optional
// `privacy?: boolean` (default false; ConnectedLiveTab feeds it from the settings store's
// `privacyMode`). With it on, code bodies (Edit fragments, Write content) are not in the DOM at
// all, while the card heading, file name and counts stay.

const SPECS = [
  {
    id: "e1",
    tool: "Edit",
    input: {
      file_path: "/r/src/city/path.ts",
      old_string: "const oldSecretPlan = 1;",
      new_string: "const newSecretPlan = 2;",
    },
    filePaths: ["/r/src/city/path.ts"],
  },
  {
    id: "w1",
    tool: "Write",
    input: { file_path: "/r/docs/x.md", content: "first line of confidential text\nsecond" },
    filePaths: ["/r/docs/x.md"],
  },
];

async function show(privacy: boolean) {
  const { calls, evidence } = build(SPECS);
  await render(
    <div data-testid="agent-panel-tab-slot">
      <LiveTab
        agentId={AGENT}
        store={seedStore()}
        select={vi.fn()}
        calls={calls}
        evidence={evidence}
        privacy={privacy}
      />
    </div>,
  );
  await paint();
  await expect.poll(() => articles().elements().length).toBe(2);
}

describe("Live tab privacy", () => {
  it("shows code bodies when privacy is off", async () => {
    await show(false);
    const text = slot().element().textContent ?? "";
    expect(text).toContain("newSecretPlan");
    expect(text).toContain("confidential text");
  });

  it("hides Edit fragments and Write content when privacy is on, keeping file names", async () => {
    await show(true);
    const text = slot().element().textContent ?? "";
    expect(text).not.toContain("oldSecretPlan");
    expect(text).not.toContain("newSecretPlan");
    expect(text).not.toContain("confidential text");
    expect(slot().element().querySelector("del, ins")).toBeNull();
    expect(text).toContain("path.ts");
    expect(text).toContain("x.md");
  });
});
