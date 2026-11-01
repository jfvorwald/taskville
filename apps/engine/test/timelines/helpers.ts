import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredEnvelope } from "@taskville/protocol";
import { afterAll, beforeAll } from "vitest";
import { bootEngine, type Engine } from "../../src/stream/index.ts";
import { bearer, CLI_TOKEN, makeApp } from "../http/helpers.ts";
import { AFTER_DAY, DAY_PROJECT, dayEvents, seedLog } from "./day-log.ts";

export { addProject, input } from "../ingest/helpers.ts";
export { bootInProcess, type Engine, ingest, useDbPath } from "../stream/helpers.ts";
export { AFTER_DAY, DAY_PROJECT, dayEvents };

export const BASE = "http://127.0.0.1:4807";

type App = ReturnType<typeof makeApp>["app"];

export function get(app: App, path: string, headers: Record<string, string> = bearer(CLI_TOKEN)) {
  return app.request(`${BASE}${path}`, { headers });
}

export async function getJson<T = Record<string, unknown>>(
  app: App,
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: T }> {
  const res = await get(app, path, headers);
  return { status: res.status, body: (await res.json()) as T };
}

export interface DayEngine {
  app: App;
  engine: Engine;
  events: StoredEnvelope[];
  pairing: ReturnType<typeof makeApp>["pairing"];
}

/**
 * One engine holding one simulated day (about 10,000 events), booted once per file. The reads
 * under test never write, so tests can share it.
 */
export function useDayEngine(): () => DayEngine {
  let dir = "";
  let day: DayEngine | undefined;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "taskville-timelines-"));
    const { app, pairing } = makeApp();
    const engine = bootEngine({
      app,
      dbPath: join(dir, "taskville.db"),
      pairing,
      now: () => AFTER_DAY,
      heartbeatMs: 60_000,
    });
    const events = dayEvents();
    seedLog(engine.storage, events);
    day = { app, engine, events, pairing };
  }, 60_000);
  afterAll(() => {
    day?.engine.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return () => {
    if (!day) throw new Error("day engine not booted");
    return day;
  };
}
