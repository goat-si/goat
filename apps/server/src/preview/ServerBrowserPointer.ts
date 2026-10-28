// @effect-diagnostics globalDate:off - Playwright waits run outside the Effect runtime.
import type { Page } from "playwright-core";

import {
  DEFAULT_TIMEOUT_MS,
  type DispatchGate,
  type PointerReporter,
  targetLocator,
} from "./ServerBrowserPage.ts";

type TargetInput = {
  readonly locator?: string | undefined;
  readonly selector?: string | undefined;
  readonly timeoutMs?: number | undefined;
};

/**
 * Moves the agent's pointer over the element an input names before the input reaches it, as a
 * click does, and returns the input with what is left of its time. The wait for the target uses
 * the input's own budget, so a control that loads late still gets its pointer; a Stop during the
 * move sends nothing. Input into whatever has focus draws no pointer.
 */
export const pointBefore = async <Input extends TargetInput>(
  page: Page,
  input: Input,
  pointer: PointerReporter,
  gate: DispatchGate,
): Promise<Input> => {
  const locator = targetLocator(page, input);
  if (locator === null) return input;
  const ends = Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const box = await locator
    .boundingBox({ timeout: Math.max(1, ends - Date.now()) })
    .catch(() => null);
  // A desktop page's viewport is unknown to Playwright; its boxes are still in viewport pixels.
  const viewport = page.viewportSize();
  const point = box && { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (
    point &&
    (viewport === null ||
      (point.x >= 0 && point.y >= 0 && point.x <= viewport.width && point.y <= viewport.height))
  )
    await pointer(point, "move");
  gate();
  return { ...input, timeoutMs: Math.max(1, ends - Date.now()) };
};
