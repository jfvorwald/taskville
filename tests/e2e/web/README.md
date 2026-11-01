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
node tests/e2e/web/measure.ts [--headed] [--moving 10] [--settle 8] [--idle 10] [--port 4886]
```

Headless Chromium draws with software GL, so use `--headed` on the target machine for an
integrated-GPU figure.

## Shared files

`apps/web/e2e/engine.ts` must issue a pairing code named `web`: add `"web"` to `CODE_NAMES`. The
config and `measure.ts` set `E2E_SPEC=web`, so that code is issued last and survives.
