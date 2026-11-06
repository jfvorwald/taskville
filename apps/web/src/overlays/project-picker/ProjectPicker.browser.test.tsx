import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { DEFAULT_PROJECT_ID, projectSelection, selectProject } from "../../data/project.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";

// M7.21: the header's project picker. It reads GET /v1/projects, opens the city on the default
// project (remembered choice, else the most recently active user project, else Unsorted), lists
// every project by name in a control labelled "Project", and remembers the viewer's choice in
// localStorage across reloads. It is a native <select>; option values are project IDs.

const projects = [
  { id: "unsorted", name: "Unsorted", roots: [], builtin: true, head: 90 },
  { id: "alpha", name: "Alpha", roots: ["/a"], builtin: false, head: 10 },
  { id: "beta", name: "Beta", roots: ["/b"], builtin: false, head: 40 },
];

function stubProjects(list: typeof projects) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ projects: list }), { status: 200 })),
  );
}

async function mount() {
  return render(
    <SessionProvider value="secret">
      <ProjectPicker />
    </SessionProvider>,
  );
}

const picker = () => page.getByRole("combobox", { name: "Project" });

beforeEach(() => {
  window.localStorage.clear();
  selectProject(DEFAULT_PROJECT_ID);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  selectProject(DEFAULT_PROJECT_ID);
});

describe("ProjectPicker", () => {
  it("lists every project by name", async () => {
    stubProjects(projects);
    await mount();
    await expect.element(picker()).toBeVisible();
    await expect.element(page.getByRole("option", { name: "Unsorted" })).toBeInTheDocument();
    await expect.element(page.getByRole("option", { name: "Alpha" })).toBeInTheDocument();
    await expect.element(page.getByRole("option", { name: "Beta" })).toBeInTheDocument();
  });

  it("opens the city on the most recently active user project", async () => {
    stubProjects(projects);
    await mount();
    await vi.waitFor(() => expect(projectSelection.getState().projectId).toBe("beta"));
    await expect.element(picker()).toHaveValue("beta");
  });

  it("switches the current project when another is picked", async () => {
    stubProjects(projects);
    await mount();
    await vi.waitFor(() => expect(projectSelection.getState().projectId).toBe("beta"));
    await picker().selectOptions("alpha");
    expect(projectSelection.getState().projectId).toBe("alpha");
    await expect.element(picker()).toHaveValue("alpha");
  });

  it("remembers the choice across a reload", async () => {
    stubProjects(projects);
    const first = await mount();
    await vi.waitFor(() => expect(projectSelection.getState().projectId).toBe("beta"));
    await picker().selectOptions("alpha");
    await first.unmount();

    // A reload: the in-memory selection is gone, localStorage is not.
    projectSelection.setState({ projectId: DEFAULT_PROJECT_ID });
    await mount();
    await vi.waitFor(() => expect(projectSelection.getState().projectId).toBe("alpha"));
    await expect.element(picker()).toHaveValue("alpha");
  });

  it("falls back to the most recently active project when the remembered one is gone", async () => {
    stubProjects(projects);
    const first = await mount();
    await vi.waitFor(() => expect(projectSelection.getState().projectId).toBe("beta"));
    await picker().selectOptions("alpha");
    await first.unmount();

    stubProjects(projects.filter((p) => p.id !== "alpha"));
    projectSelection.setState({ projectId: DEFAULT_PROJECT_ID });
    await mount();
    await vi.waitFor(() => expect(projectSelection.getState().projectId).toBe("beta"));
    await expect.element(picker()).toHaveValue("beta");
  });

  it("keeps and remembers choices made while the list is loading, even away and back", async () => {
    let release: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    await mount();
    selectProject("alpha");
    selectProject(DEFAULT_PROJECT_ID);
    release(new Response(JSON.stringify({ projects }), { status: 200 }));
    await expect.element(picker()).toBeVisible();
    expect(projectSelection.getState().projectId).toBe(DEFAULT_PROJECT_ID);
    expect(window.localStorage.getItem("taskville.project")).toBe(DEFAULT_PROJECT_ID);
  });

  it("refreshes the list when the picker gets focus, without moving the city", async () => {
    stubProjects(projects);
    await mount();
    await vi.waitFor(() => expect(projectSelection.getState().projectId).toBe("beta"));
    stubProjects([
      ...projects,
      { id: "gamma", name: "Gamma", roots: ["/g"], builtin: false, head: 999 },
    ]);
    (picker().element() as HTMLSelectElement).focus();
    await expect.element(page.getByRole("option", { name: "Gamma" })).toBeInTheDocument();
    expect(projectSelection.getState().projectId).toBe("beta");
  });
});
