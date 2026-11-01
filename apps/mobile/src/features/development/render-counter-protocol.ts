import {
  LEGACY_RENDER_COUNTER_GLOBALS,
  LEGACY_MOBILE_INSPECTOR_APP_PREFIX,
  LEGACY_MOBILE_DEVELOPMENT_SCHEME,
} from "@goat/contracts/legacyT3Names";
import { MOBILE_APP_IDENTITY } from "@goat/shared/mobileAppIdentity";

export const RENDER_COUNTER_GLOBALS = {
  open: "__goatRenderCounterOpen",
  reload: "__goatRenderCounterReload",
  start: "__goatRenderCounterStart",
  stop: "__goatRenderCounterStop",
} as const;

type Operation = keyof typeof RENDER_COUNTER_GLOBALS;

export function isRenderCounterApp(appId: string): boolean {
  return (
    Object.values(MOBILE_APP_IDENTITY).some(
      (identity) => identity.iosBundleIdentifier === appId || identity.androidPackage === appId,
    ) || appId.startsWith(LEGACY_MOBILE_INSPECTOR_APP_PREFIX)
  );
}

/** Select capabilities before calling: retrying a failed operation could repeat a side effect. */
export function renderCounterCall(operation: Operation, ...args: ReadonlyArray<unknown>): string {
  return `(() => { const names = ${JSON.stringify([RENDER_COUNTER_GLOBALS, LEGACY_RENDER_COUNTER_GLOBALS])}.find(names => Object.values(names).every(name => typeof globalThis[name] === "function")); if (!names) throw new Error("Render counter unavailable; enable EXPO_PUBLIC_GOAT_RENDER_COUNTER"); return globalThis[names[${JSON.stringify(operation)}]](...${JSON.stringify(args)}); })()`;
}

/** Old measurement scripts and current ones must operate on the same counter state. */
export function renderCounterAliases<T extends Record<Operation, (...args: never[]) => unknown>>(
  counter: T,
) {
  return Object.fromEntries(
    (Object.keys(RENDER_COUNTER_GLOBALS) as Operation[]).flatMap((operation) => [
      [RENDER_COUNTER_GLOBALS[operation], counter[operation]],
      [LEGACY_RENDER_COUNTER_GLOBALS[operation], counter[operation]],
    ]),
  );
}

export function renderCounterScheme(appId: string, override?: string): string {
  if (override !== undefined) return override;
  const identity = Object.values(MOBILE_APP_IDENTITY).find(
    (identity) => identity.iosBundleIdentifier === appId || identity.androidPackage === appId,
  );
  return (
    identity?.scheme ??
    (appId.startsWith(LEGACY_MOBILE_INSPECTOR_APP_PREFIX)
      ? LEGACY_MOBILE_DEVELOPMENT_SCHEME
      : MOBILE_APP_IDENTITY.development.scheme)
  );
}
