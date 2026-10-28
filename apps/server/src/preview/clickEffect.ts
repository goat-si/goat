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
 * Runs in the clicked frame, as source: the server has no DOM types. A change counts only when
 * the click caused it: made while one of its own events is dispatched, a navigation it started,
 * or input and focus landing on its target. Nothing is credited for being near or in time.
 */
const INSTALL = `(() => {
  const seen = new Set();
  let armed = false;
  let target = null;
  let resolve = () => undefined;
  const changed = new Promise((done) => (resolve = done));
  const note = (kind) => {
    if (!armed) return;
    seen.add(kind);
    resolve();
  };
  // Shadow-inclusive: a node inside a shadow root is within its host.
  const within = (node, ancestor) => {
    for (let at = node; at; at = at.parentNode || at.host) if (at === ancestor) return true;
    return false;
  };
  // window.event names the click's event during its listeners and their microtasks, even ones the
  // page registered first; inside shadow trees it is hidden, so dispatches the window's capture
  // phase saw count while their eventPhase is not NONE.
  const types = new Set(["pointerdown", "mousedown", "pointerup", "mouseup", "click",
    "contextmenu", "dblclick"]);
  const dispatching = new Set();
  const handled = () => {
    const current = window.event;
    if (current && current.isTrusted && types.has(current.type)) return true;
    for (const event of dispatching) if (event.eventPhase === 0) dispatching.delete(event);
    return dispatching.size > 0;
  };
  const observer = new MutationObserver((records) => records.length && handled() && note("dom"));
  const options = { subtree: true, childList: true, attributes: true, characterData: true };
  const observed = new Set();
  const watch = (root) => {
    if (root && !observed.has(root)) {
      observed.add(root);
      observer.observe(root, options);
    }
  };
  watch(document);
  const begin = (event) => {
    if (!event.isTrusted) return;
    // Changes pending from before this event are ambient.
    observer.takeRecords();
    dispatching.add(event);
    for (const node of event.composedPath()) if (node instanceof ShadowRoot) watch(node);
  };
  // Input and focus count when the click caused them or they land on or around its target.
  const related = (event) => {
    if (handled()) return true;
    const at = event.composedPath()[0];
    return target !== null && at !== document.body && at !== document.documentElement &&
      (within(at, target) || within(target, at));
  };
  const onInput = (event) => related(event) && note("input");
  const onFocus = (event) => related(event) && note("focus");
  // A link or form the click activated starts a user-initiated navigation; a handler's own
  // location change happens during dispatch. Navigations other work started are not the click's.
  const onNavigate = (event) => (event.userInitiated || handled()) && note("navigation");
  const navigation = window.navigation;
  const listeners = [[document, "input", onInput], [document, "change", onInput],
    [document, "focusin", onFocus], ...[...types].map((type) => [window, type, begin])];
  for (const [on, type, listener] of listeners) on.addEventListener(type, listener, true);
  navigation?.addEventListener("navigate", onNavigate);
  const deepest = (x, y) => {
    let found = document.elementFromPoint(x, y);
    while (found && found.shadowRoot) {
      const inner = found.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === found) break;
      found = inner;
    }
    return found;
  };
  const arm = (at) => {
    seen.clear();
    target = at && typeof at.x === "number" ? deepest(at.x, at.y) : at;
    if (target) watch(target.getRootNode());
    armed = true;
  };
  const stop = () => {
    armed = false;
    resolve();
    dispatching.clear();
    observer.disconnect();
    for (const [on, type, listener] of listeners) on.removeEventListener(type, listener, true);
    navigation?.removeEventListener("navigate", onNavigate);
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
  const seen = new Set<ClickEvidence>();
  let armed = false;
  let wake = constVoid;
  const woke = new Promise<void>((resolve) => (wake = resolve));
  // A popup needs the user activation the click gave; one opened without it is blocked.
  const onPopup = () => {
    if (!armed) return;
    seen.add("popup");
    wake();
  };
  // A navigation that replaces the document cannot be read from the page while it is pending, so a
  // request for a new document in the clicked frame after arming counts. Same-document changes
  // are judged in the page, where a change other work made is not the click's.
  const onRequest = (request: Request) => {
    if (!armed || !request.isNavigationRequest()) return;
    const navigated = request.frame();
    if (navigated !== page.mainFrame() && navigated !== frame) return;
    seen.add("navigation");
    wake();
  };
  page.on("popup", onPopup);
  page.on("request", onRequest);
  // A page that cannot run script, or that a dialog holds, still reports popups and dialogs.
  const installing = Promise.resolve()
    .then(() => frame.evaluateHandle(INSTALL) as Promise<JSHandle<Watch>>)
    .catch(() => undefined);
  const watch = await bounded(installing, INSTALL_MS);
  if (watch === undefined) void installing.then((late) => late && stopWatch(late));
  const release = () => {
    page.off("popup", onPopup);
    page.off("request", onRequest);
    // Not awaited: a dialog the page opened holds every evaluation until it closes.
    if (watch) stopWatch(watch);
  };
  const record = (kinds: ReadonlyArray<string> | void | undefined) => {
    for (const kind of kinds ?? []) seen.add(kind as ClickEvidence);
  };
  const arm = async (aim: ClickAim) => {
    armed = true;
    const target: unknown = "element" in aim ? aim.element : aim.point;
    await bounded(watch?.evaluate((state, at) => state.arm(at), target).catch(constVoid));
  };
  const settle = async (dialog = false): Promise<ClickEffect> => {
    try {
      if (dialog) seen.add("dialog");
      else {
        // The first signal's kinds arrive with it, before a navigation can replace the document.
        await bounded(
          Promise.race([
            woke,
            watch
              ?.evaluate((state) => state.changed.then(() => [...state.seen]))
              .then(record, constVoid),
          ]),
        );
        // A failed read proves nothing.
        record(
          await bounded(
            watch
              ?.evaluate((state) => {
                state.stop();
                return [...state.seen];
              })
              .catch(() => undefined),
          ),
        );
      }
      return { effect: seen.size > 0 ? "confirmed" : "suspected_noop", evidence: [...seen] };
    } finally {
      release();
    }
  };
  return { arm, settle, cancel: release };
};
