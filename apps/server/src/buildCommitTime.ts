declare const __GOAT_BUILD_COMMIT_TIME__: string | undefined;

/**
 * Unix seconds of the commit this server was built from, stamped by the pack build
 * (`apps/server/vite.config.ts`). SSH runtime refresh uses it to order builds whose
 * versions do not order themselves, such as `0.1.0-dev.<sha>`. Unstamped builds, such as
 * source runs and tests, report `undefined`.
 */
export const BUILD_COMMIT_TIME: number | undefined = (() => {
  const raw = typeof __GOAT_BUILD_COMMIT_TIME__ === "string" ? __GOAT_BUILD_COMMIT_TIME__ : "";
  return /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : undefined;
})();
