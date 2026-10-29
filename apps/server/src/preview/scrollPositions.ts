// @effect-diagnostics globalTimers:off - Playwright page reads run outside the Effect runtime.
import type { ElementHandle, Page } from "playwright-core";

/** Where a scroll moved: an element and its scroll ancestors, a wheel point, or the window. */
export type ScrollScope =
  | { readonly element: ElementHandle }
  | { readonly point: { readonly x: number; readonly y: number } }
  | undefined;

type View = {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly document: { elementFromPoint(x: number, y: number): unknown };
  requestAnimationFrame(callback: () => void): number;
};
type Box = {
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly parentElement: Box | null;
};

// Page-side functions run alone in the page, so each carries its own offset walk.
const fromElement = (start: unknown) =>
  new Promise<string>((resolve) => {
    const view = globalThis as unknown as View;
    view.requestAnimationFrame(() => {
      const offsets = [view.scrollX, view.scrollY];
      for (let node = start as Box | null; node; node = node.parentElement)
        offsets.push(node.scrollLeft, node.scrollTop);
      resolve(offsets.join(","));
    });
  });
const fromPoint = ([x, y]: readonly [number, number]) =>
  new Promise<string>((resolve) => {
    const view = globalThis as unknown as View;
    view.requestAnimationFrame(() => {
      const offsets = [view.scrollX, view.scrollY];
      for (
        let node = view.document.elementFromPoint(x, y) as Box | null;
        node;
        node = node.parentElement
      )
        offsets.push(node.scrollLeft, node.scrollTop);
      resolve(offsets.join(","));
    });
  });

const frameRead = (page: Page, scope: ScrollScope): Promise<string> =>
  scope && "element" in scope
    ? scope.element.evaluate(fromElement)
    : scope && "point" in scope
      ? page.evaluate(fromPoint, [scope.point.x, scope.point.y] as const)
      : page.evaluate(fromElement, null);

/**
 * Waits until the scroll offsets read the same on two consecutive animation frames. A server
 * timer bounds every read, so a page whose frames stopped answers settled: false in time.
 */
export const settleScroll = async (
  page: Page,
  scope: ScrollScope,
  gateDeadline: number | undefined,
): Promise<boolean> => {
  // The gate's deadline is on the performance.now() clock.
  const end = Math.min(performance.now() + 1_000, (gateDeadline ?? Infinity) - 250);
  let last: string | undefined;
  for (;;) {
    const left = end - performance.now();
    if (left <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = await Promise.race([
      frameRead(page, scope).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), left);
      }),
    ]);
    clearTimeout(timer);
    if (next === undefined) return false;
    if (next === last) return true;
    last = next;
  }
};
