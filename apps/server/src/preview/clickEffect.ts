// @effect-diagnostics globalTimers:off - Playwright callbacks run outside the Effect runtime.
/**
 * What a click did, read as computer use reads input: a change it caused confirms it, nothing seen
 * is a suspected no-op. Late effects and ambient activity (a clock, a poll) are not counted.
 */
import { constVoid } from "effect/Function";
import type { ElementHandle, Frame, JSHandle, Locator, Page } from "playwright-core";

export type ClickEvidence =
  | "dom"
  | "input"
  | "focus"
  | "navigation"
  | "popup"
  | "download"
  | "dialog";

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
  readonly navigated: Promise<boolean>;
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
  let navigatedNow = () => undefined;
  const navigated = new Promise((done) => (navigatedNow = done));
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
  // The press moves focus as its mousedown's default action, so a blur, change or focus the browser
  // dispatches between its pointerdown and pointerup (validation on leaving a field) is the click's.
  const focusTypes = new Set(["blur", "focusout", "change", "focus", "focusin"]);
  let pressed = false;
  const handled = () => {
    const current = window.event;
    if (current && current.isTrusted && types.has(current.type)) return true;
    if (pressed && current && current.isTrusted && focusTypes.has(current.type)) return true;
    for (const event of dispatching) if (event.eventPhase === 0) dispatching.delete(event);
    return dispatching.size > 0;
  };
  // A write that leaves the value as it was, such as the same attribute or text set again, is not a
  // change; each attribute and text node is judged by its value before the batch and now.
  // A child list counts as changed only when it differs from how it was before the batch,
  // rebuilt by undoing the batch's records in reverse; text counts by its content.
  const sameNode = (left, right) => left === right ||
    (left.nodeType === 3 && right.nodeType === 3 && left.data === right.data);
  const childrenChanged = (records) => {
    const lists = new Map();
    for (const record of records) if (record.type === "childList") lists.set(record.target, null);
    for (const parent of lists.keys()) {
      // A detached node, such as a measuring probe already removed, is not part of the page.
      if (!parent.isConnected) continue;
      let children = [...parent.childNodes];
      for (const record of [...records].reverse()) {
        if (record.type !== "childList" || record.target !== parent) continue;
        children = children.filter((node) => ![...record.addedNodes].includes(node));
        const next = record.nextSibling ? children.indexOf(record.nextSibling) : -1;
        const previous = record.previousSibling ? children.indexOf(record.previousSibling) : -1;
        const at = next >= 0 ? next : previous >= 0 ? previous + 1 : record.nextSibling ? 0 :
          children.length;
        children.splice(at, 0, ...record.removedNodes);
      }
      const now = [...parent.childNodes];
      if (now.length !== children.length || now.some((node, i) => !sameNode(node, children[i])))
        return true;
    }
    return false;
  };
  const changedIn = (records) => {
    if (childrenChanged(records)) return true;
    const before = new Map();
    for (const record of records) {
      if (record.type === "childList" || !record.target.isConnected) continue;
      const key = record.target;
      const name = record.type === "attributes" ? record.attributeName : "";
      const entries = before.get(key) ?? new Map();
      if (!entries.has(name)) entries.set(name, record.oldValue);
      before.set(key, entries);
    }
    for (const [node, entries] of before)
      for (const [name, old] of entries)
        if ((name === "" ? node.data : node.getAttribute(name)) !== old) return true;
    return false;
  };
  const observer = new MutationObserver((records) => handled() && changedIn(records) && note("dom"));
  const options = { subtree: true, childList: true, attributes: true, characterData: true,
    attributeOldValue: true, characterDataOldValue: true };
  const observed = new Set();
  const watch = (root) => {
    if (root && !observed.has(root)) {
      observed.add(root);
      observer.observe(root, options);
    }
  };
  watch(document);
  // The browser closes open auto popovers on a press outside them, after the press's mousedown and
  // before its pointerup; those it closes then are the click's.
  let dismissible = new Set();
  const begin = (event) => {
    if (!event.isTrusted) return;
    if (event.type === "pointerdown") {
      pressed = true;
      dismissible = new Set(document.querySelectorAll(":popover-open"));
    }
    if (event.type === "pointerup") {
      pressed = false;
      dismissible = new Set();
    }
    if (event.type === "click") opensWindow(event);
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
  // A native disclosure or popover the click toggled, after its dispatch: the details holding the
  // target, or the popover the target controls. Toggles elsewhere are not the click's.
  const controls = (toggled) => {
    for (let at = target; at; at = at.parentNode || at.host)
      if (toggled === at.popoverTargetElement || toggled === at.commandForElement) return true;
    return false;
  };
  // toggle fires only once the state changed, so a toggle a beforetoggle listener cancelled is not
  // counted; a light dismiss is noted at its beforetoggle, as its toggle comes after pointerup.
  const dismissed = new Set();
  const onBeforeToggle = (event) => {
    const toggled = event.composedPath()[0];
    if (event.newState === "closed" && dismissible.has(toggled)) dismissed.add(toggled);
  };
  const onToggle = (event) => {
    const toggled = event.composedPath()[0];
    if ((target !== null && (within(target, toggled) || controls(toggled))) ||
        dismissed.has(toggled))
      note("dom");
  };
  // Input counts when the clicked control's value or checked state really changed.
  const controlsAt = new Map();
  const remember = (control) => control && "value" in control &&
    controlsAt.set(control, [control.value, control.checked]);
  const onInput = (event) => {
    const control = event.composedPath()[0];
    const before = controlsAt.get(control);
    if (before && (before[0] !== control.value || before[1] !== control.checked)) note("input");
  };
  const onFocus = (event) => related(event) && note("focus");
  // A link or form the click activated starts a user-initiated navigation; a handler's own
  // location change happens during dispatch. Navigations other work started are not the click's.
  // A link the click follows into a new window opens a popup unless a handler cancels the click,
  // judged after its dispatch. A window an earlier click opened is not this click's.
  const opensWindow = (event) => {
    const link = event.composedPath().find((node) => node.tagName === "A" && node.href);
    if (!link || ["", "_self", "_parent", "_top"].includes(link.target)) return;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      if (!event.defaultPrevented) note("popup");
    };
    channel.port2.postMessage(null);
  };
  // Judged after the event's dispatch, in a message task (timers can be throttled), since a guard
  // listener may cancel it after this one ran.
  const onNavigate = (event) => {
    if (!armed || !(event.userInitiated || handled())) return;
    // A fragment link to where the page already is changes nothing.
    if (event.destination.sameDocument && event.destination.url === location.href) return;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      if (event.defaultPrevented) return;
      note(event.downloadRequest == null ? "navigation" : "download");
      navigatedNow(true);
    };
    channel.port2.postMessage(null);
  };
  const navigation = window.navigation;
  const listeners = [[document, "input", onInput], [document, "change", onInput],
    [document, "focusin", onFocus], [document, "beforetoggle", onBeforeToggle],
    [document, "toggle", onToggle], ...[...types].map((type) => [window, type, begin])];
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
    controlsAt.clear();
    dismissed.clear();
    remember(target);
    remember(target?.control);
    remember(target?.closest?.("label")?.control);
    armed = true;
  };
  const stop = () => {
    armed = false;
    pressed = false;
    resolve();
    navigatedNow(false);
    dispatching.clear();
    observer.disconnect();
    for (const [on, type, listener] of listeners) on.removeEventListener(type, listener, true);
    navigation?.removeEventListener("navigate", onNavigate);
  };
  return { seen, changed, navigated, arm, stop };
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
  // The page says the click followed a link into a new window; the browser says one opened. A
  // popup counts only with both: a blocked one (a sandboxed frame) or an earlier click's does not.
  let opened = false;
  let openedNow = constVoid;
  const windowOpened = new Promise<void>((resolve) => (openedNow = resolve));
  const onPopup = () => {
    opened = true;
    openedNow();
  };
  page.on("popup", onPopup);
  // A page that cannot run script, or that a dialog holds, still reports a dialog the press opened.
  const installing = Promise.resolve()
    .then(() => frame.evaluateHandle(INSTALL) as Promise<JSHandle<Watch>>)
    .catch(() => undefined);
  const watch = await bounded(installing, INSTALL_MS);
  if (watch === undefined) void installing.then((late) => late && stopWatch(late));
  const release = () => {
    page.off("popup", onPopup);
    // Not awaited: a dialog the page opened holds every evaluation until it closes.
    if (watch) stopWatch(watch);
  };
  const record = (kinds: ReadonlyArray<string> | void | undefined) => {
    for (const kind of kinds ?? []) seen.add(kind as ClickEvidence);
  };
  // Asked before the press: a read issued once a navigation is pending never answers, but one
  // already waiting does, so a navigation the page attributes to the click still reports.
  let first: Promise<void> | undefined;
  let navigated: Promise<void> | undefined;
  const arm = async (aim: ClickAim) => {
    const target: unknown = "element" in aim ? aim.element : aim.point;
    await bounded(watch?.evaluate((state, at) => state.arm(at), target).catch(constVoid));
    first = watch
      ?.evaluate((state) => state.changed.then(() => [...state.seen]))
      .then(record, constVoid);
    navigated = watch
      ?.evaluate((state) => state.navigated.then(() => [...state.seen]))
      .then(record, constVoid);
  };
  const settle = async (dialog = false): Promise<ClickEffect> => {
    try {
      if (dialog) seen.add("dialog");
      else {
        // The first signal's kinds arrive with it, before a navigation can replace the document.
        await bounded(first);
        // A navigation the click started was noted before the press returned, so this is quick.
        await bounded(navigated, 5);
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
      // The window's page appears a little after the link activation; a blocked one never does.
      if (seen.has("popup") && !opened) await bounded(windowOpened, INSTALL_MS);
      if (!opened) seen.delete("popup");
      return { effect: seen.size > 0 ? "confirmed" : "suspected_noop", evidence: [...seen] };
    } finally {
      release();
    }
  };
  return { arm, settle, cancel: release };
};
