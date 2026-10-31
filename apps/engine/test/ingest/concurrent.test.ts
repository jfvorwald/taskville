import { Worker } from "node:worker_threads";
import type { ProjectState } from "@taskville/domain/reducer";
import { projectStateHash, replay } from "@taskville/domain/reducer";
import { describe, expect, it } from "vitest";
import { openStorage } from "../../src/storage/index.ts";
import { useStorage } from "./helpers.ts";

const db = useStorage(["demo"]);

function runWriter(path: string, writer: number, batches: number, perBatch: number) {
  return new Promise<number[]>((resolve, reject) => {
    const worker = new Worker(new URL("./concurrent-writer.ts", import.meta.url), {
      workerData: { path, writer, batches, perBatch },
    });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`writer ${writer} exited with ${code}`));
    });
  });
}

describe("concurrent writers on separate connections", () => {
  it("keep the per-project sequence gap-free and the projection consistent", async () => {
    db.storage().close();
    const [a, b, c] = await Promise.all([
      runWriter(db.path(), 1, 20, 25),
      runWriter(db.path(), 2, 20, 25),
      runWriter(db.path(), 3, 20, 25),
    ]);
    const all = [...(a ?? []), ...(b ?? []), ...(c ?? [])].sort((x, y) => x - y);
    expect(all).toEqual(Array.from({ length: 1500 }, (_, i) => i + 2));

    const storage = openStorage(db.path());
    try {
      expect(storage.head("demo")).toBe(1501);
      const projection = storage.projection<ProjectState>("demo");
      expect(projection?.head).toBe(1501);
      expect(projection?.stateHash).toBe(projectStateHash(replay("demo", storage.events("demo"))));
    } finally {
      storage.close();
    }
  }, 60_000);
});
