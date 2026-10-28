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
 * Runs in the clicked frame, as source: the server has no DOM types. After `arm` it counts any
 * change at or around the target, elements added or removed while the click's own events are
 * handled, input, focus and URL. What happens elsewhere between events (a feed, a clock) is ambient.
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
  // A change counts as the target's when it happens inside it, changes an ancestor's own
  // attributes, or adds or removes the target itself; children added to an ancestor do not.
  const near = (record) => target !== null && (target.contains(record.target) ||
    (record.type === "attributes" && record.target.contains(target)) ||
    (record.type === "childList" && [...record.addedNodes, ...record.removedNodes]
      .some((node) => node.contains(target))));
  const elementIn = (nodes) => Array.from(nodes).some((node) => node.nodeType === 1);
  const consider = (records, handled) => {
    for (const record of records)
      if (near(record) || (handled && record.type === "childList" &&
          (elementIn(record.addedNodes) || elementIn(record.removedNodes))))
        return note("dom");
  };
  // From the moment a click event starts until its task ends, microtasks included, element
  // changes anywhere are its own, even when a handler stops propagation; earlier ones are ambient.
  let handling = false;
  let settleTask;
  const observer = new MutationObserver((records) => consider(records, handling));
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const begin = () => {
    consider(observer.takeRecords(), handling);
    handling = true;
    clearTimeout(settleTask);
    settleTask = setTimeout(() => {
      consider(observer.takeRecords(), true);
      handling = false;
    }, 0);
  };
  const phases = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].map((type) => [
    window, type, begin, true]);
  const onInput = () => note("input");
  const onFocus = () => note("focus");
  const onUrl = () => location.href !== href && note("url");
  const listeners = [[document, "input", onInput], [document, "change", onInput],
    [document, "focusin", onFocus], [window, "popstate", onUrl], [window, "hashchange", onUrl]];
  for (const [on, type, listener] of listeners) on.addEventListener(type, listener, true);
  for (const [on, type, listener, capture] of phases) on.addEventListener(type, listener, capture);
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
    clearTimeout(settleTask);
    observer.disconnect();
    for (const [on, type, listener] of listeners) on.removeEventListener(type, listener, true);
    for (const [on, type, listener, capture] of phases) on.removeEventListener(type, listener, capture);
  };
  return { seen, changed, arm, stop };
})()`;

/** A wait on the page that a dialog it opens could block forever; undefined once it runs out. */
const bounded = async <A>(work: Promise<A> | undefined, ms = SETTLE_MS) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms))),
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

/** The offset of a frame's content inside the parent frame's viewport: past border and padding. */
const contentOrigin = (x: number, y: number) => `(() => {
  const el = document.elementFromPoint(${x}, ${y});
  if (!el) return null;
  const box = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return [box.left + el.clientLeft + parseFloat(style.paddingLeft),
    box.top + el.clientTop + parseFloat(style.paddingTop)];
})()`;

const disposeAim = (aim: ClickAim | undefined) => {
  if (aim && "element" in aim) void aim.element.dispose().catch(constVoid);
};

/**
 * Where a click lands: a locator's own element and frame, or the innermost frame under a page
 * point, with the point in that frame's coordinates. Bounded as a whole, since a dialog the page
 * opens holds every evaluation; a late result is released. `release` drops the element it holds.
 */
export const aimClick = async (
  page: Page,
  locator: Locator | null,
  point: Point,
): Promise<ClickAim> => {
  const finding = findAim(page, locator, point).catch(() => undefined);
  const aim = await bounded(finding, 2 * SETTLE_MS);
  if (aim === undefined) void finding.then(disposeAim);
  return aim ?? { point };
};
export const releaseAim = disposeAim;

const findAim = async (page: Page, locator: Locator | null, point: Point): Promise<ClickAim> => {
  if (locator !== null) {
    const element = await locator.elementHandle({ timeout: SETTLE_MS }).catch(() => null);
    const frame = element ? await element.ownerFrame() : null;
    if (element && frame) return { frame, element };
    void element?.dispose().catch(constVoid);
  }
  let frame = page.mainFrame();
  let at = point;
  for (let depth = 0; depth < 3; depth++) {
    const hit = await frame.evaluateHandle(`document.elementFromPoint(${at.x}, ${at.y})`);
    const element = hit.asElement();
    const child = element ? await element.contentFrame().catch(() => null) : null;
    void hit.dispose().catch(constVoid);
    if (!child) break;
    const origin = (await frame.evaluate(contentOrigin(at.x, at.y))) as [number, number] | null;
    if (!origin) break;
    frame = child;
    at = { x: at.x - origin[0], y: at.y - origin[1] };
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
