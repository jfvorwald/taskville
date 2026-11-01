/**
 * The URL-triggered test hooks (`?tv-fixture=agents`, `?debug=movement`, `?debug=celebrations`)
 * exist only in builds made with `VITE_TV_TEST_HOOKS=1`, which is what `test:e2e` does. A normal
 * build or dev server leaves them off, so a pasted URL cannot switch them on.
 */
export type TestHooksEnv = { readonly VITE_TV_TEST_HOOKS?: string };

/**
 * Without `env` the flag is read from `import.meta.env` on every call. It is read as a property
 * access so the bundler replaces it with a constant and drops the hooks from an unflagged build.
 */
export function testHooksEnabled(env?: TestHooksEnv): boolean {
  const flag = env === undefined ? import.meta.env.VITE_TV_TEST_HOOKS : env.VITE_TV_TEST_HOOKS;
  return flag === "1";
}

/** True when test hooks are built in and the URL asks for `?debug=<hook>`. */
export function debugHookRequested(
  search: string,
  hook: "movement" | "celebrations",
  env?: TestHooksEnv,
): boolean {
  return testHooksEnabled(env) && new URLSearchParams(search).get("debug") === hook;
}
