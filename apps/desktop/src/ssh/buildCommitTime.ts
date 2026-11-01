declare const __GOAT_BUILD_COMMIT_TIME__: string | undefined;

/**
 * Unix seconds of the commit this app was built from, stamped into the main bundle by
 * `apps/desktop/vite.config.ts` with the same value as the server archive packaged beside it.
 * Unstamped runs, such as tests, report `undefined`.
 */
export const DESKTOP_BUILD_COMMIT_TIME: number | undefined = (() => {
  const raw = typeof __GOAT_BUILD_COMMIT_TIME__ === "string" ? __GOAT_BUILD_COMMIT_TIME__ : "";
  return /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : undefined;
})();
