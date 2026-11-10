import { formatCostUsd, formatTokens } from "./format.ts";
import type { AgentCostView } from "./useAgentCost.ts";

/** Tokens and cost for the panel header; rendered only when telemetry reported them. */
export function AgentCost({ view, className }: { view: AgentCostView; className?: string }) {
  const { input, output, cacheRead, cacheCreation } = view.tokens;
  return (
    <p className={className} data-testid="agent-panel-cost">
      <span
        data-testid="agent-panel-tokens"
        data-input={input}
        data-output={output}
        data-cache-read={cacheRead}
        data-cache-creation={cacheCreation}
      >
        {formatTokens(input + output + cacheRead + cacheCreation)} tokens
      </span>
      <span data-testid="agent-panel-cost-usd">{formatCostUsd(view.costUsd)}</span>
    </p>
  );
}
