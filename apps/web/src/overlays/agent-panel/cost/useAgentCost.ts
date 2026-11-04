import { useEffect, useState } from "react";
import { SESSION_HEADER } from "../../../pairing/pair.ts";
import { useSession } from "../../../pairing/session.tsx";

export interface AgentCostView {
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  costUsd: number;
}

/** Answers with the agent's cost, or `undefined` when no telemetry named it. */
export type CostSource = (
  agentId: string,
  signal: AbortSignal,
) => Promise<AgentCostView | undefined>;

/** The default source: `GET /v1/agents/:id/cost` with the paired session (404 is "nothing"). */
export function sessionCostSource(secret: string): CostSource {
  return async (agentId, signal) => {
    const response = await fetch(`/v1/agents/${encodeURIComponent(agentId)}/cost`, {
      headers: { [SESSION_HEADER]: secret },
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    return (await response.json()) as AgentCostView;
  };
}

function useOptionalSession(): string | undefined {
  try {
    // The hook always runs; only its "outside a paired app" throw is caught (tests and previews).
    // biome-ignore lint/correctness/useHookAtTopLevel: useContext is called on every render.
    return useSession();
  } catch {
    return undefined;
  }
}

/**
 * The selected agent's cost: the given source, else the engine's endpoint under a paired app,
 * else nothing. A failure, a 404 and a stale answer all leave `undefined` (no invented zero).
 */
export function useAgentCost(
  agentId: string | undefined,
  costSource: CostSource | undefined,
): AgentCostView | undefined {
  const secret = useOptionalSession();
  const [answer, setAnswer] = useState<{ agentId: string; view: AgentCostView } | undefined>();

  useEffect(() => {
    const source = costSource ?? (secret === undefined ? undefined : sessionCostSource(secret));
    setAnswer(undefined);
    if (agentId === undefined || source === undefined) return;
    const controller = new AbortController();
    source(agentId, controller.signal).then(
      (view) => {
        if (!controller.signal.aborted && view !== undefined) setAnswer({ agentId, view });
      },
      () => {},
    );
    return () => controller.abort();
  }, [agentId, costSource, secret]);

  return answer !== undefined && answer.agentId === agentId ? answer.view : undefined;
}
