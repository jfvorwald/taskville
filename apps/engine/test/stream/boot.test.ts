import { DatabaseSync } from "node:sqlite";
import { REDUCER_VERSION } from "@taskville/domain/reducer";
import { afterEach, describe, expect, it } from "vitest";
import { openStorage } from "../../src/storage/index.ts";
import { addProject, bootInProcess, type Engine, ingest, input, useDbPath } from "./helpers.ts";

const dbPath = useDbPath();
let engine: Engine | undefined;
afterEach(() => {
  engine?.close();
  engine = undefined;
});

describe("bootEngine", () => {
  it("creates the database, the Unsorted project, and its projection on first boot", () => {
    engine = bootInProcess(dbPath()).engine;
    expect(engine.storage.project("unsorted")).toMatchObject({ builtin: true, head: 1 });
    expect(engine.storage.projection("unsorted")).toMatchObject({
      head: 1,
      reducerVersion: REDUCER_VERSION,
    });
    expect(engine.rebuilt).toEqual(["unsorted"]);
  });

  it("rebuilds projections whose reducer version is stale before serving", async () => {
    const first = bootInProcess(dbPath());
    addProject(first.engine.storage, "demo");
    await ingest(first.app, [input("e1")]);
    const good = first.engine.storage.projection("demo");
    first.engine.close();

    // Pretend an older reducer wrote the projections.
    const raw = new DatabaseSync(dbPath());
    raw.exec("UPDATE projections SET reducer_version = 0, state_hash = '0:x', state_json = '{}'");
    raw.close();

    const second = bootInProcess(dbPath());
    engine = second.engine;
    expect(engine.rebuilt.sort()).toEqual(["demo", "unsorted"]);
    expect(engine.storage.projection("demo")).toEqual(good);
  });

  it("does nothing extra on a warm boot", () => {
    bootInProcess(dbPath()).engine.close();
    engine = bootInProcess(dbPath()).engine;
    expect(engine.rebuilt).toEqual([]);
    expect([...engine.storage.events("unsorted")]).toHaveLength(1);
  });

  it("reports storage health for /health", () => {
    engine = bootInProcess(dbPath()).engine;
    expect(engine.health()).toEqual({ db: "ok", walMode: true });
    engine.close();
    expect(engine.health()).toEqual({ db: "error", walMode: false });
    engine = undefined;
  });

  it("closes open streams and the database on close", async () => {
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    const res = await booted.app.request("http://127.0.0.1:4807/v1/projects/unsorted/events", {
      headers: {
        Host: "127.0.0.1:4807",
        Authorization: `Bearer ${"cli-token-0123456789abcdefghijklmnopqrstuvwxyzAB"}`,
      },
    });
    const reader = res.body?.getReader();
    await reader?.read();
    engine.close();
    engine = undefined;
    let done = false;
    for (let i = 0; i < 10 && !done; i++) done = (await reader?.read())?.done ?? true;
    expect(done).toBe(true);
    expect(() => openStorage(dbPath()).close()).not.toThrow();
  });
});
