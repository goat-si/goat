import type { ClickReport } from "./clickState.ts";

type PopupCandidateTab = {
  readonly threadId: string;
  readonly tabId: string;
  readonly openerTabId?: string | null | undefined;
};

type ClickPopupTab = {
  readonly threadId: string;
  readonly tabId: string;
  readonly page: { url(): string };
};

export const makeClickPopupTracker = () => {
  const adoptionsByKey = new Map<string, Set<(adoption: Promise<string | undefined>) => void>>();
  const keyOf = (threadId: string, tabId: string) => `${threadId}:${tabId}`;

  const observe = (
    tab: Pick<ClickPopupTab, "threadId" | "tabId">,
    adoption: Promise<string | undefined>,
    onError: (cause: unknown) => Promise<void>,
  ) => {
    const settled = adoption.catch(async (cause: unknown) => {
      await onError(cause);
      return undefined;
    });
    const watchers = adoptionsByKey.get(keyOf(tab.threadId, tab.tabId));
    if (watchers) for (const notify of watchers) notify(settled);
  };

  const trackClick = async (
    tab: ClickPopupTab,
    tabs: { values(): Iterable<PopupCandidateTab> },
    deadlineMs: number,
    signal: AbortSignal | undefined,
    run: () => Promise<ClickReport>,
  ) => {
    const key = keyOf(tab.threadId, tab.tabId);
    const existingPopups = new Set(
      Array.from(tabs.values())
        .filter(
          (candidate) => candidate.threadId === tab.threadId && candidate.openerTabId === tab.tabId,
        )
        .map((candidate) => candidate.tabId),
    );
    const adoptions: Array<Promise<string | undefined>> = [];
    const onAdopt = (adoption: Promise<string | undefined>) => {
      adoptions.push(adoption);
    };
    const watchers = adoptionsByKey.get(key) ?? new Set();
    watchers.add(onAdopt);
    adoptionsByKey.set(key, watchers);
    let clicked: ClickReport;
    try {
      clicked = await run();
    } finally {
      watchers.delete(onAdopt);
      if (watchers.size === 0) adoptionsByKey.delete(key);
    }
    const { effect, evidence, pressesCompleted, pressed, checked } = clicked;
    let openedTabId: string | undefined;
    if (adoptions.length > 0 && !signal?.aborted) {
      const waitMs = Math.min(2_000, Math.max(0, Math.floor(deadlineMs - performance.now())));
      if (waitMs > 0) {
        const timeoutSignal = AbortSignal.timeout(waitMs);
        const waitSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        const abortWait = Promise.withResolvers<undefined>();
        const onAbort = () => abortWait.resolve(undefined);
        if (waitSignal.aborted) {
          abortWait.resolve(undefined);
        } else {
          waitSignal.addEventListener("abort", onAbort, { once: true });
        }
        try {
          const settled = await Promise.race([
            Promise.all(adoptions).then((ids) => ids.find((id) => id !== undefined)),
            abortWait.promise,
          ]);
          if (settled !== undefined) openedTabId = settled;
        } finally {
          waitSignal.removeEventListener("abort", onAbort);
        }
      }
    }
    if (openedTabId === undefined) {
      const created = Array.from(tabs.values()).find(
        (candidate) =>
          candidate.threadId === tab.threadId &&
          candidate.openerTabId === tab.tabId &&
          !existingPopups.has(candidate.tabId),
      );
      if (created) openedTabId = created.tabId;
    }
    const clickEvidence =
      openedTabId !== undefined && !evidence?.includes("popup")
        ? [...(evidence ?? []), "popup" as const]
        : evidence;
    const clickEffect = openedTabId !== undefined ? ("confirmed" as const) : effect;
    return {
      effect: clickEffect,
      evidence: clickEvidence,
      url: tab.page.url(),
      ...(openedTabId === undefined ? {} : { openedTabId }),
      ...(pressesCompleted === undefined ? {} : { pressesCompleted }),
      ...(pressed === undefined ? {} : { pressed, checked }),
    };
  };

  return { observe, trackClick };
};
