import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { CountsHeader } from "../overlays/header/CountsHeader.tsx";
import { createAnchorSource } from "../overlays/host/anchors.ts";
import type { AgentCounts, OverlayProps, Selector } from "../overlays/host/types.ts";
import { SessionProvider } from "../pairing/session.tsx";
import { useRelease } from "./identity.ts";

// M7.26 review (#423): useRelease makes exactly one /health call for a paired session, none when
// unpaired, and a failing /health leaves the header rendering without a badge.

const staging = { id: "20261106-abc1234", version: "1.4.0", environment: "staging" };

function stubFetch(handler: (url: string) => Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return url === "/health" ? handler(url) : Promise.reject(new Error("offline"));
    }),
  );
  return () => calls.filter((u) => u === "/health").length;
}

function Probe() {
  const release = useRelease();
  return (
    <p data-testid="probe">{release === null ? "none" : `${release.environment}:${release.id}`}</p>
  );
}

const countsValue: AgentCounts = { active: 1, needsYou: 0 };
const counts: Selector<AgentCounts> = {
  subscribe: () => () => {},
  getSnapshot: () => countsValue,
};
const headerProps: OverlayProps = {
  mode: "live",
  selectors: { counts },
  selection: { selectedId: null, select: () => {} },
  anchors: createAnchorSource(),
  intents: { available: true, run: () => {} },
  settings: { get: (_k, f) => f, set: () => {} },
};

afterEach(() => vi.unstubAllGlobals());

describe("useRelease", () => {
  it("calls /health exactly once for a paired session and exposes the release", async () => {
    const healthCalls = stubFetch(
      async () => new Response(JSON.stringify({ status: "ok", release: staging }), { status: 200 }),
    );
    await render(
      <SessionProvider value="secret-1">
        <Probe />
      </SessionProvider>,
    );
    await expect.element(page.getByTestId("probe")).toHaveTextContent(`staging:${staging.id}`);
    expect(healthCalls()).toBe(1);
  });

  it("does not call /health when unpaired", async () => {
    const healthCalls = stubFetch(async () => new Response("{}", { status: 200 }));
    await render(<Probe />);
    await expect.element(page.getByTestId("probe")).toHaveTextContent("none");
    await new Promise((r) => setTimeout(r, 50));
    expect(healthCalls()).toBe(0);
  });

  it("keeps the header rendering, without a badge, when /health fails", async () => {
    const healthCalls = stubFetch(async () => new Response("down", { status: 503 }));
    await render(
      <SessionProvider value="secret-1">
        <CountsHeader {...headerProps} />
      </SessionProvider>,
    );
    await expect.element(page.getByText("1 active · 0 need you")).toBeVisible();
    await vi.waitFor(() => expect(healthCalls()).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(page.getByText("STAGING").elements()).toHaveLength(0);
    expect(page.getByText("production").elements()).toHaveLength(0);
    expect(page.getByText("development").elements()).toHaveLength(0);
  });
});
