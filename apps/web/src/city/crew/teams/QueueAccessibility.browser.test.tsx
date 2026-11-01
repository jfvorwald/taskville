import { Canvas, type RootState, type ThreeEvent } from "@react-three/fiber";
import { type Object3D, Vector3 } from "three";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  OTHER_TASK,
  PROJECT,
  TASK,
  TEAM,
  teamScenario,
} from "../../../../test/city/crew/teams/integration.fixture.ts";
import { dataStore } from "../../../data/store.ts";
import { AgentList } from "../../../overlays/agent-list/AgentList.tsx";
import { createAnchorSource } from "../../../overlays/host/anchors.ts";
import type { OverlayProps } from "../../../overlays/host/types.ts";
import { CityRoot } from "../../index.tsx";

const WAIT = { timeout: 10_000 };
const props: OverlayProps = {
  mode: "live",
  selectors: {
    counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
  },
  selection: { selectedId: null, select: (id) => dataStore.getState().select(id) },
  anchors: createAnchorSource(),
  intents: { available: true, run: () => {} },
  settings: { get: (_key, fallback) => fallback, set: () => {} },
};

afterEach(() => dataStore.getState().reset(PROJECT));

function drawn(object: Object3D) {
  for (let p: Object3D | null = object; p; p = p.parent) if (!p.visible) return false;
  let drawable = false;
  object.traverseVisible((child) => {
    if (child.type === "Mesh" || child.type === "Sprite") drawable = true;
  });
  return drawable;
}

// Reach the control through the browser's real tab order, including after a rerender.
async function tabTo(element: Element) {
  for (let i = 0; i < 30 && document.activeElement !== element; i++) {
    await userEvent.keyboard("{Tab}");
  }
  expect(document.activeElement, "queue control participates in keyboard tab order").toBe(element);
}

it("mirrors all 40 recorded team tasks between keyboard queue paging and mounted canvas controls", async () => {
  const scenario = teamScenario();
  dataStore.getState().reset(PROJECT);
  dataStore.getState().applySnapshotState(scenario.state);
  const ids = [
    TASK,
    ...Array.from({ length: 39 }, (_, i) => `claude-code:task:integration:${i + 2}`),
  ].sort();
  for (const id of ids.filter((id) => id !== TASK)) {
    const event = scenario.createTask(id);
    dataStore.getState().applyEvent(event);
  }
  const state = dataStore.getState().state;
  if (!state) throw new Error("Missing recorded queue fixture");
  const titles = new Map(ids.map((id) => [id, state.tasks[id]?.title ?? id]));
  const byTitle = new Map([...titles].map(([id, title]) => [title, id]));
  expect(state.tasks[OTHER_TASK]?.title).toBe("Other team's task");

  let root: RootState | undefined;
  const screen = await render(
    <>
      <AgentList {...props} />
      <div style={{ width: 320, height: 240 }}>
        <Canvas
          frameloop="never"
          onCreated={(value) => {
            root = value;
          }}
        >
          <CityRoot />
        </Canvas>
      </div>
    </>,
  );
  const objects = () => {
    const all: Object3D[] = [];
    root?.scene.traverse((object) => all.push(object));
    return all;
  };
  const canvasIds = () =>
    objects()
      .filter(
        (object) =>
          object.userData.teamId === TEAM && object.userData.taskId !== undefined && drawn(object),
      )
      .map((object) => object.userData.taskId as string);
  const region = page.getByRole("region", { name: /Team tasks/i });
  const button = (direction: "previous" | "next") =>
    region.getByRole("button", { name: new RegExp(direction, "i") });
  const domIds = () => {
    // Read actual literal text in DOM order, independent of list/table/details layout.
    const walker = document.createTreeWalker(region.element(), NodeFilter.SHOW_TEXT);
    const result: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const id = byTitle.get(node.textContent?.trim() ?? "");
      if (id && (node.parentElement?.checkVisibility() ?? false)) result.push(id);
    }
    return result;
  };
  const synchronized = async (expected: string[]) => {
    await vi.waitFor(() => {
      expect(canvasIds()).toEqual(expected);
      expect(domIds(), "accessible literal task text matches the drawn team page").toEqual(
        expected,
      );
      expect(region.element().textContent).not.toContain("Other team's task");
    }, WAIT);
  };
  const enter = async (direction: "previous" | "next") => {
    const control = button(direction);
    await expect.element(control).toBeEnabled();
    await tabTo(control.element());
    await expect.element(control).toHaveFocus();
    await userEvent.keyboard("{Enter}");
  };
  const boundary = async (direction: "previous" | "next", expected: string[]) => {
    // A boundary button may be absent or disabled. If kept enabled it must be inert.
    if (
      button(direction).query() &&
      !button(direction).element().matches(":disabled, [aria-disabled='true']")
    ) {
      await enter(direction);
    }
    await synchronized(expected);
  };
  try {
    await vi.waitFor(() => expect(canvasIds().length).toBeGreaterThan(0), WAIT);
    await expect.element(page.getByRole("grid", { name: "Agents" })).toBeVisible();
    // Permit the existing native disclosure primitive without requiring a layout.
    const summary = [...document.querySelectorAll("details:not([open]) > summary")].find(
      (element) => /Team tasks/i.test(element.textContent ?? ""),
    );
    if (summary) {
      await tabTo(summary);
      await userEvent.keyboard("{Enter}");
    }
    // The initial red must identify the missing accessible fallback, before paging assertions.
    await expect.element(region).toBeVisible();
    const first = canvasIds();
    expect(first.length).toBeLessThan(ids.length);
    await boundary("previous", first);
    const pages: string[][] = [];
    const seen: string[] = [];
    for (let attempt = 0; attempt < ids.length; attempt++) {
      const current = canvasIds();
      expect(current.length).toBeGreaterThan(0);
      expect(current).toEqual(ids.slice(seen.length, seen.length + current.length));
      await synchronized(current);
      pages.push(current);
      seen.push(...current);
      if (seen.length === ids.length) break;
      await enter("next");
      await vi.waitFor(() => expect(canvasIds()).not.toEqual(current), WAIT);
    }
    expect(seen).toEqual(ids);
    expect(new Set(seen).size).toBe(40);
    await boundary("next", pages.at(-1) ?? []);
    for (const expected of pages.slice(0, -1).reverse()) {
      await enter("previous");
      await synchronized(expected);
    }
    await boundary("previous", first);
    await enter("next");
    await synchronized(pages[1] ?? []);

    const controls = objects().filter(
      (object) =>
        object.userData.teamId === TEAM &&
        object.userData.queuePageDirection === "previous" &&
        drawn(object),
    );
    expect(controls).toHaveLength(1);
    const control = controls[0];
    if (!control) throw new Error("Missing mounted previous control");
    const descendants: Object3D[] = [];
    control.traverseVisible((object) => descendants.push(object));
    const handler = descendants
      .map(
        (object) =>
          (
            object as Object3D & {
              __r3f?: { handlers: { onClick?: (event: ThreeEvent<MouseEvent>) => void } };
            }
          ).__r3f?.handlers.onClick,
      )
      .find((value) => value !== undefined);
    expect(handler, "drawn previous control has a mounted handler").toBeTypeOf("function");
    control.updateWorldMatrix(true, false);
    // Mounted R3F handler only. Physical raycasting and occlusion are outside this component test.
    handler?.({
      object: control,
      eventObject: control,
      point: control.getWorldPosition(new Vector3()),
      nativeEvent: new MouseEvent("click"),
      stopPropagation() {},
    } as ThreeEvent<MouseEvent>);
    await synchronized(first);
  } finally {
    await screen.unmount();
  }
}, 30_000);
