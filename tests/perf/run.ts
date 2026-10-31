// Perf and soak checks for spec 001 SC-004, SC-005, SC-006 (#103). Not part of `pnpm check`:
// run once per milestone and attach the output.
//
//   pnpm perf [all|batch|latency|soak]
//
// Exits 1 when a target is missed, so a miss is visible; every number is printed either way.
import { batchCheck } from "./batch.ts";
import { machine } from "./engine.ts";
import { LATENCY_TARGET_MS, latencyCheck } from "./latency.ts";
import { MEMORY_GROWTH_LIMIT, soakRun } from "./soak.ts";

const which = process.argv[2] ?? "all";
if (!["all", "batch", "latency", "soak"].includes(which)) {
  console.error("Usage: pnpm perf [all|batch|latency|soak]");
  process.exit(2);
}
const ms = (n: number) => `${n.toFixed(1)} ms`;
const verdict = (pass: boolean) => (pass ? "PASS" : "MISS");
let allPass = true;

const m = await machine();
console.log(`# Taskville perf checks (${new Date().toISOString()})`);
console.log(
  `Machine: ${m.cpu}, ${m.cores} cores, ${m.memoryGiB} GiB, ${m.platform} ${m.arch}, Node ${m.node}\n`,
);

if (which === "all" || which === "batch") {
  const r = await batchCheck();
  allPass &&= r.pass;
  console.log(`## SC-004: 1,000-event batch, target under 1 s: ${verdict(r.pass)}`);
  console.log(
    `HTTP POST /v1/events/batch (spawned serve, demo events), ${r.runs} runs: ${r.httpRunsMs.map(ms).join(", ")}`,
  );
  console.log(`  p50 ${ms(r.http.p50)}, max ${ms(r.http.max)}`);
  console.log(
    `In-process bench (M1.12, apps/engine/src/ingest/bench.ts):\n  ${r.inProcessOutput.split("\n").join("\n  ")}\n`,
  );
}

if (which === "all" || which === "latency") {
  const r = await latencyCheck();
  allPass &&= r.pass;
  console.log(
    `## SC-005: ingest to connected viewer, target under ${LATENCY_TARGET_MS} ms for every probe: ${verdict(r.pass)}`,
  );
  console.log(
    `${r.probes} single-event probes per phase, ${r.gapMs} ms apart, POST start to SSE frame parsed by a fetch-streamed viewer.`,
  );
  console.log(
    "| Phase | viewer p50 | viewer p95 | viewer p99 | viewer max | ack p50 | ack p95 | demo events | gaps or duplicates |",
  );
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const p of r.phases) {
    console.log(
      `| ${p.name} | ${ms(p.viewer.p50)} | ${ms(p.viewer.p95)} | ${ms(p.viewer.p99)} | ${ms(p.viewer.max)} | ${ms(p.ack.p50)} | ${ms(p.ack.p95)} | ${p.demoEvents} | ${p.anomalies} |`,
    );
  }
  console.log("");
}

if (which === "all" || which === "soak") {
  for (const pace of ["calm", "lively"] as const) {
    const r = await soakRun({ pace });
    // The spec's scenario is the default (calm) demo; lively is a heavier extra run, reported too.
    if (pace === "calm") allPass &&= r.pass;
    console.log(
      `## SC-006: 8-hour six-agent demo, ${pace} pace, RSS growth hour 1 to 8 under ${MEMORY_GROWTH_LIMIT * 100}%: ${verdict(r.pass)}${pace === "lively" ? " (extra, not the spec scenario)" : ""}`,
    );
    console.log(
      `Seed ${r.seed}, ${r.events} events, virtual clock ${r.speed}x (8 h in ${r.wallSeconds.toFixed(1)} s, effective ${r.effectiveSpeed.toFixed(0)}x); boot RSS ${r.bootRssMiB.toFixed(1)} MiB; viewer received ${r.viewerReceived}, gaps or duplicates ${r.viewerAnomalies}.`,
    );
    console.log(`RSS growth hour 1 to hour 8: ${(r.growth * 100).toFixed(1)}%`);
    console.log(
      "| Hour | events | RSS MiB | WAL KiB | state KiB | agents | sessions | tool calls | tasks | requests (open) | commands |",
    );
    console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const k of r.marks) {
      console.log(
        `| ${k.hour} | ${k.events} | ${k.rssMiB.toFixed(1)} | ${k.walKiB.toFixed(0)} | ${k.stateKiB.toFixed(1)} | ${k.agents} | ${k.sessions} | ${k.toolCalls} | ${k.tasks} | ${k.requests} (${k.openRequests}) | ${k.commands} |`,
      );
    }
    console.log("");
  }
}

console.log(`Overall: ${allPass ? "all targets met" : "at least one target MISSED"}`);
process.exit(allPass ? 0 : 1);
