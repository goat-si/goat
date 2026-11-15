import type { ServerProviderUsageLimits } from "@goat/contracts";

/**
 * GOAT's quota readers (placement, Fleet heat, the limits board) scope a window only through
 * scopeModel, so a window scoped to one model gets it and any other scoped window is left out
 * rather than read as provider-wide.
 */
export function withGoatUsageScopes(limits: ServerProviderUsageLimits): ServerProviderUsageLimits {
  const windows = limits.windows.flatMap((window) => {
    if (window.modelIds === undefined && window.providerIds === undefined) return [window];
    const [model, ...others] = window.modelIds ?? [];
    return window.providerIds === undefined && model !== undefined && others.length === 0
      ? [{ ...window, scopeModel: window.scopeModel ?? model }]
      : [];
  });
  return windows.length === limits.windows.length &&
    windows.every((window, index) => window === limits.windows[index])
    ? limits
    : { ...limits, windows };
}
