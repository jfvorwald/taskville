/** Token counts for the panel header: `950`, `12.3k`, `1k`, `1.5M`. */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${trim((count / 1000).toFixed(1))}k`;
  return `${trim((count / 1_000_000).toFixed(1))}M`;
}

/** A cost in US dollars: `$0.42`; a positive cost under one cent is `<$0.01`. */
export function formatCostUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

function trim(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}
