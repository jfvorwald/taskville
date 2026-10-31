import type { ProjectsResponse, SnapshotResponse } from "@taskville/protocol";
import type { EngineClient } from "../client.ts";
import type { Io } from "../context.ts";
import { parseCommand, printJson, required } from "../context.ts";
import { CliError, EXIT } from "../errors.ts";
import { renderStatus, type StatusSnapshot, statusJson } from "../status.ts";

const USAGE = "taskville status --project <id> [--all] [--json]";

/** The project's snapshot; an unknown project exits 2 with its ID in the message. */
export async function fetchSnapshot(
  client: EngineClient,
  projectId: string,
): Promise<StatusSnapshot> {
  try {
    const path = `/v1/projects/${encodeURIComponent(projectId)}/snapshot`;
    return (await client.json<SnapshotResponse>("GET", path)) as unknown as StatusSnapshot;
  } catch (error) {
    if (error instanceof CliError && error.code === EXIT.notFound) {
      throw new CliError(EXIT.notFound, `Unknown project "${projectId}"`);
    }
    throw error;
  }
}

export async function status(io: Io, args: string[]): Promise<number> {
  const { values, context } = parseCommand(
    io,
    args,
    { project: { type: "string" }, all: { type: "boolean" } },
    USAGE,
  );
  const projectId = required(values, "project", USAGE);
  const all = values.all === true;
  const client = context.client();
  const snapshot = await fetchSnapshot(client, projectId);
  if (context.json) {
    printJson(io, statusJson(snapshot, { all }));
  } else {
    const { projects } = await client.json<ProjectsResponse>("GET", "/v1/projects");
    const projectName = projects.find((p) => p.id === projectId)?.name ?? projectId;
    io.stdout(renderStatus(snapshot, { projectName, all }));
  }
  return EXIT.ok;
}
