// @effect-diagnostics globalTimers:off - Playwright callbacks run outside the Effect runtime.
/**
 * What a click visibly did, read the way computer use reads an input: a change tied to the click
 * seen right after it confirms the click; nothing seen is a suspected no-op, which an agent
 * observes before retrying. Late effects (a fetch that renders after the window) are not seen,
 * and ambient page activity (a ticking clock, a background poll) does not count.
 *
 * @module clickEffect
 */
import { constVoid } from "effect/Function";
import type { Frame, JSHandle, Page, Request } from "playwright-core";

export type ClickEvidence = "dom" | "input" | "focus" | "url" | "navigation" | "popup" | "dialog";

export interface ClickEffect {
  readonly effect: "confirmed" | "suspected_noop";
  readonly evidence: ReadonlyArray<ClickEvidence>;
}

/** Long enough for a handler's own work and a navigation request; short enough per click. */
const SETTLE_MS = 50;

interface Watch {
  readonly seen: Set<string>;
  readonly changed: Promise<void>;
  readonly arm: (x: number, y: number) => void;
  readonly stop: () => void;
}

/**
 * Runs in the page. Counts only what `arm` starts: element nodes added or removed anywhere (a
 * menu, a dialog), any change at or around the element under the click point, input, focus and
 * URL changes. Text-only changes elsewhere, such as a clock, are ambient.
 */
const install = () => {
  const seen = new Set<string>();
  let armed = false;
  let target: Node | null = null;
  let resolve: () => void = () => undefined;
  const changed = new Promise<void>((done) => (resolve = done));
  const note = (kind: string) => {
    if (!armed) return;
    seen.add(kind);
    resolve();
  };
  const near = (node: Node) => target !== null && (target.contains(node) || node.contains(target));
  const elementIn = (nodes: NodeList) =>
    Array.from(nodes).some((node) => node.nodeType === Node.ELEMENT_NODE);
  const observer = new MutationObserver((records) => {
    for (const record of records)
      if (
        near(record.target) ||
        (record.type === "childList" &&
          (elementIn(record.addedNodes) || elementIn(record.removedNodes)))
      )
        return note("dom");
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  const onInput = () => note("input");
  const onFocus = () => note("focus");
  let href = location.href;
  const onUrl = () => location.href !== href && note("url");
  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onInput, true);
  document.addEventListener("focusin", onFocus, true);
  window.addEventListener("popstate", onUrl);
  window.addEventListener("hashchange", onUrl);
  const arm = (x: number, y: number) => {
    seen.clear();
    href = location.href;
    target = document.elementFromPoint(x, y);
    armed = true;
  };
  const stop = () => {
    onUrl();
    armed = false;
    resolve();
    observer.disconnect();
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("change", onInput, true);
    document.removeEventListener("focusin", onFocus, true);
    window.removeEventListener("popstate", onUrl);
    window.removeEventListener("hashchange", onUrl);
  };
  return { seen, changed, arm, stop };
};

/** A wait on the page that a dialog it opens could block forever; undefined once it runs out. */
const bounded = async <A>(work: Promise<A> | undefined, ms = SETTLE_MS) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => (timer = setTimeout(resolve, ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Starts watching before the click. `arm` begins counting right before the press, at the point
 * the click goes to; `settle` waits briefly after it and returns the verdict.
 */
export const watchClick = async (page: Page) => {
  const url = page.url();
  const seen = new Set<ClickEvidence>();
  let armed = false;
  let wake = constVoid;
  const woke = new Promise<void>((resolve) => (wake = resolve));
  const note = (kind: ClickEvidence) => {
    if (!armed) return;
    seen.add(kind);
    wake();
  };
  const onRequest = (request: Request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) note("navigation");
  };
  const onNavigated = (frame: Frame) => {
    if (frame === page.mainFrame()) note("navigation");
  };
  const onPopup = () => note("popup");
  page.on("request", onRequest);
  page.on("framenavigated", onNavigated);
  page.on("popup", onPopup);
  // A page that cannot run script, or that a dialog holds, still reports through page events.
  const installing = Promise.resolve()
    .then(() => page.evaluateHandle(install))
    .catch(() => undefined);
  const watch: JSHandle<Watch> | undefined = await bounded(installing, 4 * SETTLE_MS);
  if (watch === undefined) void installing.then((late) => late?.dispose().catch(constVoid));
  const release = () => {
    page.off("request", onRequest);
    page.off("framenavigated", onNavigated);
    page.off("popup", onPopup);
    // Not awaited: a dialog the page opened holds every evaluation until it closes.
    void watch
      ?.evaluate((state) => state.stop())
      .catch(constVoid)
      .finally(() => void watch.dispose().catch(constVoid));
  };
  const arm = async (point: { readonly x: number; readonly y: number }) => {
    armed = true;
    await bounded(watch?.evaluate((state, at) => state.arm(at.x, at.y), point).catch(constVoid));
  };
  const settle = async (dialog = false): Promise<ClickEffect> => {
    try {
      if (dialog) seen.add("dialog");
      else {
        await bounded(
          Promise.race([woke, watch?.evaluate((state) => state.changed).catch(constVoid)]),
        );
        // A failed read proves nothing; navigation is counted from the page's own events.
        const inPage = await bounded(
          watch
            ?.evaluate((state) => {
              state.stop();
              return [...state.seen];
            })
            .catch(() => undefined),
        );
        for (const kind of inPage ?? []) seen.add(kind as ClickEvidence);
      }
      if (page.url() !== url) seen.add("url");
      return { effect: seen.size > 0 ? "confirmed" : "suspected_noop", evidence: [...seen] };
    } finally {
      release();
    }
  };
  return { arm, settle, cancel: release };
};
