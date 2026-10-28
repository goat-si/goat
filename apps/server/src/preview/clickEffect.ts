// @effect-diagnostics globalTimers:off - Playwright callbacks run outside the Effect runtime.
/**
 * What a click did, read as computer use reads input: a change it caused confirms it, nothing seen
 * is a suspected no-op. Late effects and ambient activity (a clock, a poll) are not counted.
 */
import { constVoid } from "effect/Function";
import type { ElementHandle, Frame, JSHandle, Locator, Page, Request } from "playwright-core";

export type ClickEvidence = "dom" | "input" | "focus" | "url" | "navigation" | "popup" | "dialog";

export interface ClickEffect {
  readonly effect: "confirmed" | "suspected_noop";
  readonly evidence: ReadonlyArray<ClickEvidence>;
}

/** Long enough for a handler's own work and a navigation request; short enough per click. */
const SETTLE_MS = 50;
const INSTALL_MS = 4 * SETTLE_MS;

interface Watch {
  readonly seen: Set<string>;
  readonly changed: Promise<void>;
  readonly arm: (target: unknown) => void;
  readonly stop: () => void;
}

/**
 * Runs in the clicked frame, passed as source since the server compiles without DOM types. It
 * counts what `arm` starts: elements added or removed anywhere, any change at or around the
 * target, input, focus and URL changes. Text changing elsewhere, such as a clock, is ambient.
 */
const INSTALL = `(() => {
  const seen = new Set();
  let armed = false;
  let target = null;
  let href = location.href;
  let resolve = () => undefined;
  const changed = new Promise((done) => (resolve = done));
  const note = (kind) => {
    if (!armed) return;
    seen.add(kind);
    resolve();
  };
  const near = (node) => target !== null && (target.contains(node) || node.contains(target));
  const elementIn = (nodes) => Array.from(nodes).some((node) => node.nodeType === 1);
  const observer = new MutationObserver((records) => {
    for (const record of records)
      if (near(record.target) || (record.type === "childList" &&
          (elementIn(record.addedNodes) || elementIn(record.removedNodes))))
        return note("dom");
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const onInput = () => note("input");
  const onFocus = () => note("focus");
  const onUrl = () => location.href !== href && note("url");
  const listeners = [[document, "input", onInput], [document, "change", onInput],
    [document, "focusin", onFocus], [window, "popstate", onUrl], [window, "hashchange", onUrl]];
  for (const [on, type, listener] of listeners) on.addEventListener(type, listener, true);
  const arm = (at) => {
    seen.clear();
    href = location.href;
    target = at && typeof at.x === "number" ? document.elementFromPoint(at.x, at.y) : at;
    armed = true;
  };
  const stop = () => {
    onUrl();
    armed = false;
    resolve();
    observer.disconnect();
    for (const [on, type, listener] of listeners) on.removeEventListener(type, listener, true);
  };
  return { seen, changed, arm, stop };
})()`;

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

const stopWatch = (watch: JSHandle<Watch>) =>
  void watch
    .evaluate((state) => state.stop())
    .catch(constVoid)
    .finally(() => void watch.dispose().catch(constVoid));

type Point = { readonly x: number; readonly y: number };
export type ClickAim =
  | { readonly frame?: Frame; readonly element: ElementHandle }
  | { readonly frame?: Frame; readonly point: Point };

/**
 * Where a click lands: a locator's own element and frame, or the innermost frame under a page
 * point, with the point in that frame's coordinates.
 */
export const aimClick = (page: Page, locator: Locator | null, point: Point): Promise<ClickAim> =>
  // Aiming only narrows what the watch observes; it never fails the click.
  findAim(page, locator, point).catch(() => ({ point }));

const findAim = async (page: Page, locator: Locator | null, point: Point): Promise<ClickAim> => {
  if (locator !== null) {
    const element = await bounded(locator.elementHandle({ timeout: SETTLE_MS }).catch(() => null));
    const frame = element ? await element.ownerFrame() : null;
    if (element && frame) return { frame, element };
  }
  let frame = page.mainFrame();
  let at = point;
  for (let depth = 0; depth < 3; depth++) {
    const hit = await bounded(
      frame.evaluateHandle(`document.elementFromPoint(${at.x}, ${at.y})`).catch(() => undefined),
    );
    const element = hit?.asElement() ?? null;
    const child = element ? await element.contentFrame().catch(() => null) : null;
    const box = child && element ? await element.boundingBox() : null;
    void hit?.dispose().catch(constVoid);
    if (!child || !box) break;
    frame = child;
    at = { x: point.x - box.x, y: point.y - box.y };
  }
  return { frame, point: at };
};

/**
 * Starts watching before the click. `arm` begins counting right before the press, at the click's
 * target; `settle` waits briefly after it and returns the verdict.
 */
export const watchClick = async (page: Page, frame: Frame = page.mainFrame()) => {
  let url = page.url();
  const seen = new Set<ClickEvidence>();
  let armed = false;
  let wake = constVoid;
  const woke = new Promise<void>((resolve) => (wake = resolve));
  const note = (kind: ClickEvidence) => {
    if (!armed) return;
    seen.add(kind);
    wake();
  };
  const watched = (target: Frame) => target === page.mainFrame() || target === frame;
  const onRequest = (request: Request) => {
    if (request.isNavigationRequest() && watched(request.frame())) note("navigation");
  };
  const onNavigated = (navigated: Frame) => {
    if (watched(navigated)) note("navigation");
  };
  const onPopup = () => note("popup");
  page.on("request", onRequest);
  page.on("framenavigated", onNavigated);
  page.on("popup", onPopup);
  // A page that cannot run script, or that a dialog holds, still reports through page events.
  const installing = Promise.resolve()
    .then(() => frame.evaluateHandle(INSTALL) as Promise<JSHandle<Watch>>)
    .catch(() => undefined);
  const watch = await bounded(installing, INSTALL_MS);
  if (watch === undefined) void installing.then((late) => late && stopWatch(late));
  const release = () => {
    page.off("request", onRequest);
    page.off("framenavigated", onNavigated);
    page.off("popup", onPopup);
    // Not awaited: a dialog the page opened holds every evaluation until it closes.
    if (watch) stopWatch(watch);
  };
  const arm = async (aim: ClickAim) => {
    armed = true;
    url = page.url();
    const target: unknown = "element" in aim ? aim.element : aim.point;
    await bounded(watch?.evaluate((state, at) => state.arm(at), target).catch(constVoid));
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
