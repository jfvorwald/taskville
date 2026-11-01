export const TEAMMATE_QUIET_MS = 5 * 60 * 1000;
interface IdleInput {
  readonly activity: string;
  readonly openToolCalls: number;
  readonly claimedTasks: number;
  readonly lastEventAtMs?: number;
}
export function teammateIdle(input: IdleInput, nowMs: number) {
  const free = input.openToolCalls === 0 && input.claimedTasks === 0;
  const observed = free && input.activity === "idle";
  const heuristic =
    free &&
    input.activity === "unknown" &&
    input.lastEventAtMs !== undefined &&
    nowMs - input.lastEventAtMs >= TEAMMATE_QUIET_MS;
  const idle = observed || heuristic;
  return { idle, heuristic: !observed && heuristic, emote: idle ? "zzz" : null };
}
