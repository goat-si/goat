import type { ServerProviderUsageLimits } from "@goat/contracts";

/**
 * One reading of quota for a decision: a numeric window, or a pool-wide availability block with no
 * percentage. Placement, fallback, host health, pressure ranking and Fleet heat all judge with it.
 */
export interface VerdictWindow {
  readonly label: string;
  readonly usedPercent?: number | undefined;
  readonly resetsAt?: string | undefined;
  readonly scopeModel?: string | undefined;
  /** The producer's verdict for this window; it wins over the percentage. */
  readonly exhausted?: boolean | undefined;
  readonly observedAt?: string | undefined;
}

/** A reading older than this only counts when it proves exhaustion. */
const QUOTA_MAX_AGE_MS = 5 * 60 * 1000;

const millis = (value: string | undefined) => (value === undefined ? undefined : Date.parse(value));

export function verdictWindows(
  limits: Pick<ServerProviderUsageLimits, "windows" | "availability">,
): ReadonlyArray<VerdictWindow> {
  return [...limits.windows, ...(limits.availability ?? [])];
}

/** A scoped window gates only its model or model family; with no model it gates nothing. */
export function appliesToModel(scopeModel: string | undefined, selected: string | undefined) {
  if (scopeModel === undefined) return true;
  const model = selected?.split("/").at(-1);
  if (scopeModel === model || scopeModel === selected) return true;
  // OpenCodex proves Claude family scopes; versioned models in that family share the limit.
  if (scopeModel.startsWith("family:")) {
    const family = scopeModel.slice("family:".length);
    return model === family || model?.startsWith(`claude-${family}-`) === true;
  }
  return false;
}

const resetPassed = (window: VerdictWindow, now: number) => {
  const resets = millis(window.resetsAt);
  return resets !== undefined && !Number.isNaN(resets) && resets <= now;
};

/** A passed reset clears it; otherwise an explicit verdict wins, then a full percentage. */
export function isWindowExhausted(window: VerdictWindow, now: number): boolean {
  if (resetPassed(window, now)) return false;
  if (window.exhausted !== undefined) return window.exhausted;
  return window.usedPercent !== undefined && window.usedPercent >= 100;
}

/**
 * Drops readings whose reset passed, and stale readings unless they prove exhaustion. A window's
 * own observation time wins over when its report was assembled.
 */
export function freshWindows<W extends VerdictWindow>(
  windows: ReadonlyArray<W>,
  checkedAt: string | undefined,
  now: number,
): ReadonlyArray<W> {
  return windows.filter((window) => {
    if (resetPassed(window, now)) return false;
    const observed = millis(window.observedAt ?? checkedAt);
    const stale =
      observed !== undefined && (!Number.isFinite(observed) || now - observed > QUOTA_MAX_AGE_MS);
    return !stale || isWindowExhausted(window, now);
  });
}
