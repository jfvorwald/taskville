// @taskville/demo: the seeded six-agent demo producer (spec 001 US3, FR-013). Pure: no Node
// built-ins, clock, or Math.random; time is a virtual clock and randomness is mulberry32.

export { type OfflineOptions, type OfflineRun, runOffline, toStoredEvents } from "./offline.ts";
export { CALM, formatPace, LIVELY, type Pace, parseDuration, parsePace } from "./pace.ts";
export {
  DemoIngestError,
  type ProducerOptions,
  type ProducerSummary,
  runProducer,
} from "./producer.ts";
export { mulberry32, type Random, type Rng, seededRng } from "./rng.ts";
export {
  type DemoEvent,
  type DemoOptions,
  type DemoStep,
  demoSteps,
  generateDemo,
} from "./scenario.ts";
export { DEMO_EPOCH_MS, isoFromMs } from "./time.ts";
