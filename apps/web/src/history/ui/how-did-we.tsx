import { Button } from "react-aria-components";
import type { ProjectState } from "../../data/domain.ts";
import { useData } from "../../data/react.ts";
import type { DataStore } from "../../data/store.ts";
import { useHistoryPresentation } from "./HistoryProvider.tsx";

export function currentTaskId(state: ProjectState | null, agentId: string): string | undefined {
  if (!state || !Object.hasOwn(state.agents, agentId)) return undefined;
  const activity = state.activity[agentId];
  if (!activity || activity.heuristic || activity.activity === "unknown") return undefined;
  return activity.taskId;
}

export function HowDidWeGetHere({
  agentId,
  mode,
  store,
}: {
  agentId: string;
  mode: "live" | "history";
  store: DataStore;
}) {
  const history = useHistoryPresentation();
  const taskId = useData((s) => currentTaskId(s.state, agentId), store);
  if (mode !== "live" || taskId === undefined) return null;
  return (
    <Button isDisabled={history.pending} onPress={() => history.enterTask(agentId, taskId)}>
      How did we get here?
    </Button>
  );
}
