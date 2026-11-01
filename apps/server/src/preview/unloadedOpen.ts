import { ServerBrowserOperationError } from "./browserOperationError.ts";

/**
 * A new tab whose first page never connected (a net::ERR_* failure other than a timeout) names
 * itself and the error, so the caller can close the tab it did not want; anything else passes on.
 */
export const unloadedOpen = (tabId: string, cause: unknown): unknown => {
  const loadError = /net::(ERR_[A-Z0-9_]+)/.exec(cause instanceof Error ? cause.message : "")?.[1];
  const timedOut =
    cause instanceof ServerBrowserOperationError && cause.tag === "PreviewAutomationTimeoutError";
  if (loadError === undefined || timedOut) return cause;
  return new ServerBrowserOperationError(
    "PreviewAutomationExecutionError",
    `The page did not load (${loadError}); its new tab ${tabId} is still open.`,
    { openedTabId: tabId, loadError },
  );
};
