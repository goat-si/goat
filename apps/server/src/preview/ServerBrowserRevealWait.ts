// @effect-diagnostics globalTimers:off - Reveal waits run inside Playwright operations outside the Effect runtime.

// A revealed tab's client opens the panel and attaches its stream a few round trips later, remote ones included.
const REVEAL_VIEWER_WAIT_MS = 1_000;

interface RevealedTab {
  readonly viewers: ReadonlySet<unknown>;
  readonly desktop: unknown;
  viewerAttached: PromiseWithResolvers<void> | null;
}

/**
 * After an explicit show, waits until a client attaches, up to a second or the call's deadline,
 * so the status it returns says the tab is visible. Desktop tabs are visible without a viewer.
 */
export const awaitRevealedViewer = async (
  tab: RevealedTab,
  reveal: boolean | undefined,
  deadlineMs: number,
) => {
  if (reveal !== true || tab.viewers.size > 0 || tab.desktop !== null) return;
  const attached = (tab.viewerAttached ??= Promise.withResolvers());
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    attached.promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(
        resolve,
        Math.max(0, Math.min(REVEAL_VIEWER_WAIT_MS, deadlineMs - performance.now())),
      );
    }),
  ]);
  clearTimeout(timer);
};

/** Ends a reveal wait: a viewer attached or the tab closed. */
export const viewerArrived = (tab: RevealedTab) => {
  tab.viewerAttached?.resolve();
  tab.viewerAttached = null;
};
