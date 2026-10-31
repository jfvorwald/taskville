import type { ProjectsResponse } from "@taskville/protocol";
import type { Io } from "../context.ts";
import { parseCommand, printJson } from "../context.ts";
import { EXIT } from "../errors.ts";
import { reasonText, retiredNotes, retiredOf } from "../status.ts";
import { fetchSnapshot } from "./status.ts";

const USAGE = "taskville requests [--project <id>] [--all] [--json]";
export const ANSWER_HINT = "Answer from the paired browser or in the agent's terminal.";

/**
 * Read-only list of pending requests (FR-018), from each project's snapshot. The CLI never
 * answers a request: it has no flag or subcommand for that, and the engine refuses its token on
 * the command route.
 */
export async function requests(io: Io, args: string[]): Promise<number> {
  const { values, context } = parseCommand(
    io,
    args,
    { project: { type: "string" }, all: { type: "boolean" } },
    USAGE,
  );
  const all = values.all === true;
  const client = context.client();
  const projectIds =
    typeof values.project === "string"
      ? [values.project]
      : (await client.json<ProjectsResponse>("GET", "/v1/projects")).projects.map((p) => p.id);
  const rows = [];
  const retired = { agents: 0, tasks: 0, requests: 0 };
  for (const projectId of projectIds) {
    const { state } = await fetchSnapshot(client, projectId);
    const counts = retiredOf(state);
    retired.agents += counts.agents;
    retired.tasks += counts.tasks;
    retired.requests += counts.requests;
    for (const request of Object.values(state.requests).sort(
      (a, b) => a.openedAt.localeCompare(b.openedAt) || a.id.localeCompare(b.id),
    )) {
      if (!all && request.state !== "open") continue;
      rows.push({
        projectId,
        agentName: state.agents[request.agentId]?.displayName ?? request.agentId,
        ...request,
      });
    }
  }
  if (context.json) {
    printJson(io, all ? { requests: rows, retired } : { requests: rows });
    return EXIT.ok;
  }
  if (rows.length === 0) io.stdout(all ? "No requests.\n" : "No open requests.\n");
  for (const r of rows) {
    io.stdout(
      `${[r.projectId, r.agentName, r.kind, r.toolName ?? "-", `since ${r.openedAt}`, `answerable: ${r.answerable ? "yes" : "no"}`, r.state, reasonText(r.reason) || "-"].join("\t")}\n`,
    );
  }
  if (all) for (const note of retiredNotes(retired, ["requests"])) io.stdout(`${note}\n`);
  io.stdout(`${ANSWER_HINT}\n`);
  return EXIT.ok;
}
