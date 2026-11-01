import type { ProjectState } from "@taskville/domain/reducer";
import type { Context } from "hono";
import type { AppEnv } from "../http/app.ts";
import { apiError } from "../http/errors.ts";
import { domainReducer } from "../ingest/index.ts";
import type { Storage } from "../storage/index.ts";

/** An agent ID is a plain string; this keeps a crafted one from costing a scan. */
const AGENT_ID_MAX = 1024;

/**
 * Whether a project has events for the agent. The projection answers a yes quickly; a no (or a
 * stale projection) is settled by reading the log, because retention may have dropped a finished
 * agent from the projection while its events remain.
 */
function holdsAgent(storage: Storage, projectId: string, agentId: string): boolean {
  const stored = storage.projection<ProjectState>(projectId);
  if (
    stored !== undefined &&
    stored.reducerVersion === domainReducer.version &&
    Object.hasOwn(stored.state.agents, agentId)
  ) {
    return true;
  }
  for (const event of storage.events(projectId, 0)) {
    if (event.agentId === agentId) return true;
  }
  return false;
}

/**
 * The project an agent's events are in (contracts/http-api.md). With `?projectId=` the request
 * names it; without, exactly one project may hold the agent. Returns the project ID, or the
 * error response: 404 `unknown_project`, 404 `unknown_agent` (also for a `projectId` that does not
 * hold the agent), 409 `ambiguous_agent`.
 */
export function resolveAgentProject(
  c: Context<AppEnv>,
  storage: Storage,
  agentId: string,
): string | Response {
  const unknownAgent = () => apiError(c, 404, "unknown_agent", "No agent with this ID");
  if (agentId.length === 0 || agentId.length > AGENT_ID_MAX) return unknownAgent();
  const named = c.req.query("projectId");
  if (named !== undefined) {
    if (storage.head(named) === undefined) {
      return apiError(c, 404, "unknown_project", "No project with this ID");
    }
    return holdsAgent(storage, named, agentId) ? named : unknownAgent();
  }
  const holders = storage
    .projects()
    .filter((project) => holdsAgent(storage, project.id, agentId))
    .map((project) => project.id);
  if (holders.length === 0) return unknownAgent();
  if (holders.length > 1) {
    return apiError(
      c,
      409,
      "ambiguous_agent",
      "Events for this agent are in more than one project; name one with ?projectId=",
    );
  }
  return holders[0] as string;
}
