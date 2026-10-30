/**
 * Pointer input at viewport points rather than elements, for maps and canvases that have none.
 *
 * @module pointerInput
 */
import type { Page } from "playwright-core";
import { remaining } from "./actionReadiness.ts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";

type Point = { readonly x: number; readonly y: number };

/**
 * Before each input after the first: an earlier one can open a dialog that holds the page past
 * the caller's deadline, or a person can take the tab, and then the rest must not go out.
 */
const again = async (gate: () => void | Promise<void>, deadline: number) => {
  if (performance.now() >= deadline)
    throw new ServerBrowserOperationError(
      "PreviewAutomationTimeoutError",
      "The deadline passed partway through the pointer input, so the rest was not sent.",
    );
  await gate();
};

/** Presses at `from`, moves in `steps` to `to`, releases; each input passes the gate first. */
export const dragBetween = async (
  page: Page,
  input: { readonly from: Point; readonly to: Point; readonly steps?: number | undefined },
  gate: () => void | Promise<void>,
  deadline: number,
) => {
  const steps = input.steps ?? 10;
  remaining(deadline);
  await gate();
  await page.mouse.move(input.from.x, input.from.y);
  await again(gate, deadline);
  await page.mouse.down();
  try {
    for (let step = 1; step <= steps; step++) {
      const along = (from: number, to: number) => from + ((to - from) * step) / steps;
      await again(gate, deadline);
      await page.mouse.move(along(input.from.x, input.to.x), along(input.from.y, input.to.y));
    }
    await again(gate, deadline);
  } catch (cause) {
    // A drag cut short still lets go of the button it pressed, where the pointer stopped.
    await page.mouse.up().catch(() => undefined);
    throw cause;
  }
  await page.mouse.up();
};

/** A real wheel at a point goes to whatever is under it, which page script can zoom on. */
export const wheelAt = async (
  page: Page,
  at: Point,
  delta: readonly [number, number],
  gate: () => void | Promise<void>,
  deadline: number,
) => {
  remaining(deadline);
  await gate();
  await page.mouse.move(at.x, at.y);
  await again(gate, deadline);
  await page.mouse.wheel(delta[0], delta[1]);
};

type Box = Point & { readonly width: number; readonly height: number };

/** Whether a box lies wholly in view; scrolling waits a frame even when nothing moves. */
export const inViewport = (box: Box | null, viewport: { width: number; height: number } | null) =>
  box !== null &&
  viewport !== null &&
  box.x >= 0 &&
  box.y >= 0 &&
  box.x + box.width <= viewport.width &&
  box.y + box.height <= viewport.height;
