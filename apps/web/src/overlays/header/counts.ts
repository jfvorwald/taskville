import type { AgentCounts } from "../host/types.ts";

const whole = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);

/** `3 active · 1 needs you`. */
export function formatCounts(counts: AgentCounts): string {
  const active = whole(counts.active);
  const needsYou = whole(counts.needsYou);
  return `${active} active · ${needsYou} ${needsYou === 1 ? "needs" : "need"} you`;
}

/** The same line, spelled out for assistive tech. */
export function describeCounts(counts: AgentCounts): string {
  const active = whole(counts.active);
  const needsYou = whole(counts.needsYou);
  return `${active} ${active === 1 ? "agent" : "agents"} active, ${needsYou} ${needsYou === 1 ? "needs" : "need"} you`;
}
