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

/** Telemetry is exported on an interval, so a selected agent's cost is asked for again. */
export const DEFAULT_COST_REFRESH_MS = 15_000;

/**
 * The selected agent's cost: the given source, else the engine's endpoint under a paired app,
 * else nothing. It asks again every `refreshMs` while the agent stays selected; the newest answer
 * wins and `undefined` removes the figure. A failure keeps what is shown, a stale answer for an
 * agent no longer selected is dropped, and unmounting aborts (no invented zero).
 */
export function useAgentCost(
  agentId: string | undefined,
  costSource: CostSource | undefined,
  refreshMs: number = DEFAULT_COST_REFRESH_MS,
): AgentCostView | undefined {
  const secret = useOptionalSession();
  const [answer, setAnswer] = useState<{ agentId: string; view: AgentCostView } | undefined>();

  useEffect(() => {
    const source = costSource ?? (secret === undefined ? undefined : sessionCostSource(secret));
    setAnswer(undefined);
    if (agentId === undefined || source === undefined) return;
    let controller = new AbortController();
    const ask = () => {
      controller.abort();
      const current = new AbortController();
      controller = current;
      source(agentId, current.signal).then(
        (view) => {
          if (current.signal.aborted) return;
          setAnswer(view === undefined ? undefined : { agentId, view });
        },
        () => {},
      );
    };
    ask();
    const timer = setInterval(ask, refreshMs);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [agentId, costSource, secret, refreshMs]);

  return answer !== undefined && answer.agentId === agentId ? answer.view : undefined;
}
