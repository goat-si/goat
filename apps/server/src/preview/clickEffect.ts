// @effect-diagnostics globalTimers:off - Playwright callbacks run outside the Effect runtime.
/**
 * What a click visibly did, read the way computer use reads an input: a change seen right
 * after it confirms the click; nothing seen is a suspected no-op, which an agent observes before
 * retrying. Late effects (a fetch that renders after the window) are not seen here.
 *
 * @module clickEffect
 */
import { constVoid } from "effect/Function";
import type { JSHandle, Page, Request } from "playwright-core";

export type ClickEvidence =
  | "dom"
  | "input"
  | "focus"
  | "url"
  | "navigation"
  | "request"
  | "popup"
  | "dialog";

export interface ClickEffect {
  readonly effect: "confirmed" | "suspected_noop";
  readonly evidence: ReadonlyArray<ClickEvidence>;
}

/** Long enough for a handler's own work and a navigation request; short enough per click. */
const SETTLE_MS = 50;

interface Watch {
  readonly seen: Set<string>;
  readonly changed: Promise<void>;
  readonly stop: () => void;
}

/** Runs in the page; listens until stopped and resolves `changed` at the first signal. */
const install = () => {
  const seen = new Set<string>();
  let resolve: () => void = () => undefined;
  const changed = new Promise<void>((done) => (resolve = done));
  const note = (kind: string) => {
    seen.add(kind);
    resolve();
  };
  const observer = new MutationObserver(() => note("dom"));
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  const onInput = () => note("input");
  const onFocus = () => note("focus");
  const href = location.href;
  const onUrl = () => location.href !== href && note("url");
  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onInput, true);
  document.addEventListener("focusin", onFocus, true);
  window.addEventListener("popstate", onUrl);
  window.addEventListener("hashchange", onUrl);
  const stop = () => {
    onUrl();
    resolve();
    observer.disconnect();
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("change", onInput, true);
    document.removeEventListener("focusin", onFocus, true);
    window.removeEventListener("popstate", onUrl);
    window.removeEventListener("hashchange", onUrl);
  };
  return { seen, changed, stop };
};

/** Starts watching before the click; `settle` waits briefly after it and returns the verdict. */
export const watchClick = async (page: Page) => {
  const url = page.url();
  const seen = new Set<ClickEvidence>();
  let wake = constVoid;
  const woke = new Promise<void>((resolve) => (wake = resolve));
  const note = (kind: ClickEvidence) => {
    seen.add(kind);
    wake();
  };
  const onRequest = (request: Request) =>
    note(
      request.isNavigationRequest() && request.frame() === page.mainFrame()
        ? "navigation"
        : "request",
    );
  const onPopup = () => note("popup");
  page.on("request", onRequest);
  page.on("popup", onPopup);
  // A page that cannot run script (or is navigating) still reports through the page events.
  const watch: JSHandle<Watch> | undefined = await page
    .evaluateHandle(install)
    .catch(() => undefined);
  const release = () => {
    page.off("request", onRequest);
    page.off("popup", onPopup);
    // Not awaited: a dialog the page opened holds every evaluation until it closes.
    void watch
      ?.evaluate((state) => state.stop())
      .catch(constVoid)
      .finally(() => void watch.dispose().catch(constVoid));
  };
  /** A bounded wait on the page, which a dialog it opens can block. */
  const bounded = async <A>(work: Promise<A> | undefined) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<undefined>((resolve) => (timer = setTimeout(resolve, SETTLE_MS))),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const settle = async (dialog = false): Promise<ClickEffect> => {
    try {
      if (dialog) seen.add("dialog");
      else {
        await bounded(
          Promise.race([woke, watch?.evaluate((state) => state.changed).catch(constVoid)]),
        );
        const inPage = await bounded(
          watch
            ?.evaluate((state) => {
              state.stop();
              return [...state.seen];
            })
            // The document the watch lived in is gone: the click navigated it away.
            .catch(() => ["navigation"]),
        );
        for (const kind of inPage ?? []) seen.add(kind as ClickEvidence);
      }
      if (page.url() !== url) seen.add("url");
      return { effect: seen.size > 0 ? "confirmed" : "suspected_noop", evidence: [...seen] };
    } finally {
      release();
    }
  };
  /** The click never went out: stop listening without a verdict. */
  const cancel = release;
  return { settle, cancel };
};
