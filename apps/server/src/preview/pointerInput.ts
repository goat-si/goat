/**
 * Pointer input at viewport points rather than elements, for maps and canvases that have none.
 *
 * @module pointerInput
 */
import type { Page } from "playwright-core";

type Point = { readonly x: number; readonly y: number };

/** Presses at `from`, moves in `steps` to `to`, releases; `dispatch` runs before any input. */
export const dragBetween = async (
  page: Page,
  input: { readonly from: Point; readonly to: Point; readonly steps?: number | undefined },
  dispatch: () => void,
) => {
  dispatch();
  await page.mouse.move(input.from.x, input.from.y);
  await page.mouse.down();
  await page.mouse.move(input.to.x, input.to.y, { steps: input.steps ?? 10 });
  await page.mouse.up();
};

/** A real wheel at a point goes to whatever is under it, which page script can zoom on. */
export const wheelAt = async (page: Page, at: Point, delta: readonly [number, number]) => {
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(delta[0], delta[1]);
};
