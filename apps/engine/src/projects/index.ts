import { randomUUID } from "node:crypto";
import {
  type CreateProjectResponse,
  createProjectRequestSchema,
  type StoredEnvelope,
} from "@taskville/protocol";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { slugify } from "../config/config.ts";
import { type AppEnv, requireScope } from "../http/app.ts";
import { apiError } from "../http/errors.ts";
import { clientContentHash, ENGINE_SOURCE_ID, type Storage } from "../storage/index.ts";

// Project registry (FR-011, decision #110 default): the engine's `projects` table is the
// registry. `POST /v1/projects` (CLI token only) and the config file's projects at engine start
// both go through `createProject`, which writes the project row and its `project.created` event
// at sequence 1 in one transaction, like `ensureUnsortedProject`. Nothing edits the config file.

/** Same rule as config-file project IDs (config.ts). */
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_NAME = 100;

export interface NewProjectInput {
  id: string;
  name: string;
  roots: readonly string[];
}

export interface CreateProjectOptions {
  now?: () => Date;
  newEventId?: () => string;
}

/** Creates the project unless the ID exists. Returns whether it was created. */
export function createProject(
  storage: Storage,
  project: NewProjectInput,
  options: CreateProjectOptions = {},
): boolean {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const eventId = (options.newEventId ?? randomUUID)();
  const roots = [...project.roots];
  return storage.transaction((tx) => {
    if (tx.project(project.id)) return false;
    tx.insertProject({ id: project.id, name: project.name, createdAt: now, roots, builtin: false });
    const created: StoredEnvelope = {
      schemaVersion: 1,
      eventId,
      projectId: project.id,
      sourceId: ENGINE_SOURCE_ID,
      sourceEventId: `project.created:${project.id}`,
      occurredAt: now,
      receivedAt: now,
      ingestSequence: 1,
      type: "project.created",
      payload: { name: project.name, roots, builtin: false },
      evidenceIds: [],
      provenance: "live",
      late: false,
    };
    tx.appendEvent(created, clientContentHash(created));
    return true;
  });
}

export interface ProjectRouteOptions extends CreateProjectOptions {
  storage: Storage;
}

/**
 * `POST /v1/projects` (contracts/http-api.md): `{ id?, name, roots }`, `id` defaulting to a slug
 * of `name`, roots absolute. 201 with head 1, 409 `project_exists` (including `unsorted`), 400
 * for anything else invalid. Registered on the app from `createApp`, so the Host, Origin, and
 * credential checks run first; the `projects` scope admits only the CLI token.
 */
export function registerProjectRoutes(app: Hono<AppEnv>, options: ProjectRouteOptions): void {
  app.post(
    "/v1/projects",
    requireScope("projects"),
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => apiError(c, 413, "payload_too_large", "Body too large"),
    }),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = createProjectRequestSchema.safeParse(body);
      if (!parsed.success) {
        return apiError(c, 400, "bad_request", "Expected { id?, name, roots: absolute paths }");
      }
      const name = parsed.data.name.trim();
      if (name === "" || [...name].length > MAX_NAME) {
        return apiError(c, 400, "bad_request", `Name must be 1 to ${MAX_NAME} characters`);
      }
      const id = parsed.data.id ?? slugify(name);
      if (!PROJECT_ID.test(id)) {
        return apiError(
          c,
          400,
          "bad_request",
          "Project ID must be 1 to 63 lowercase letters, digits, or hyphens; pass --id",
        );
      }
      const project = { id, name, roots: parsed.data.roots };
      if (!createProject(options.storage, project, options)) {
        return apiError(c, 409, "project_exists", "A project with this ID already exists");
      }
      const response: CreateProjectResponse = { ...project, head: 1 };
      return c.json(response, 201);
    },
  );
}
