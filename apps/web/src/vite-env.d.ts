/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `1` in builds made for the e2e run: turns on the URL test hooks (see `testHooks.ts`). */
  readonly VITE_TV_TEST_HOOKS?: string;
}
