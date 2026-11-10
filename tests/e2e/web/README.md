# Web smoke and performance (M3.16)

Playwright over the real engine and the built web client. Not part of `pnpm check`.

## Smoke suite (task tier, once)

Needs the test-hook build and the engine pairing code `web` (see "Shared files" below).

```sh
cd <repo root>
VITE_TV_TEST_HOOKS=1 pnpm --filter @taskville/web exec vite build
E2E_PORT=4886 pnpm --filter @taskville/web exec playwright test -c ../../tests/e2e/web/playwright.config.ts
```

## Measurement (on purpose only, machine reserved)

Prints fps with six demo agents moving and browser CPU after they settle. It asserts nothing.

```sh
pnpm --filter @taskville/web build
node tests/e2e/web/measure.ts [--headed] [--moving 10] [--settle 8] [--idle 10] [--dpr 1] [--port 4886]
```

Headless Chromium draws with software GL, so use `--headed` on the target machine for an
integrated-GPU figure. `--dpr 2` samples a Retina-class canvas (the app caps dpr at 2). Use a
temp `HOME` and `TASKVILLE_HOME` for the run (set `PLAYWRIGHT_BROWSERS_PATH` if the browsers
live under the real home).

How it measures:

- **Frames** are WebGL `clear` calls (three.js clears once per render), timestamped in the page.
  The report prints the count, the rate and the busiest one-second stretch. An idle window with no
  full-rate segment keeps that busiest second near the idle rate (about 20 to 23 frames).
- **requestAnimationFrame counter:** runs only in the moving window, to report the callback rate
  and the display refresh estimate. It is off for the idle window: a loop of its own would hold
  Blink at 60 Hz and inflate the idle CPU.
- **Idle window:** the pointer is parked in the page corner before the settle time, not just before
  the window. A pointer event holds the idle throttle at full rate for one second, which would
  otherwise lift idle fps from 20 to 21 or more. The labels are read just before and after the
  window, never during it.
- **CPU** is the whole browser (every process, GPU included) from CDP `SystemInfo.getProcessInfo`,
  as a percentage of one core. Expect about plus or minus 1 point of noise; note the machine load.

## Shared files

`apps/web/e2e/engine.ts` must issue a pairing code named `web`: add `"web"` to `CODE_NAMES`. The
config and `measure.ts` set `E2E_SPEC=web`, so that code is issued last and survives.
