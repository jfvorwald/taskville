# WAVE-M5M6: M5/M6 wave run and browser test fixes

- **Result:** done
- **PR:** none (branch wave-fixes-m5m6) · **roborev:** NOT RUN
- **Checks run:** wave run on main a93d5a1: `pnpm check` 4,493 of 4,493; app e2e, web smoke 4, crews 5, permission replay 6, telemetry replay 7 all pass. Browser suite first run aborted after 11 files on a dynamic import error (first run in a fresh worktree). Second run 906 of 912, 6 failures in 4 files: LiveFollow passed alone (flake); the other three failed alone and are fixed here. After the fixes, each file alone: cityRootMotion 2, AgentCost 9, FilesTab.history 5 passing; web typecheck clean; biome clean on the three files.
- **NOT RUN:** full browser suite after the fixes; roborev.
- **Measurements:** none
- **Decisions needed:** none
- **Review outcome:** not reviewed
- **Lessons:**
  - None of the three failures was an app bug. cityRootMotion mounts CityRoot without a Canvas and stubs scene children; CrewHighlight (f68a0e5, M5.08) and EnvelopeLayer (e871ebe, M5.04) were never stubbed, so R3F hooks ran outside a Canvas.
  - AgentCost: the first cost figure lasted one 40 ms refresh, shorter than expect.element's 50 ms poll. The source now keeps answering the first figure until the test has seen it.
  - FilesTab history: the panel's cost read (M5.12, by contract in both modes) was counted as a Files read; the fetch stub now answers /cost with 404 before recording.
  - A first browser run in a fresh worktree can abort on a dynamic import error; rerun once.
