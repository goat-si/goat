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
 * Moves the agent's pointer to the element an input names, as a click does, within the input's
 * budget and the caller's deadline, and returns the input with the time left. The gate is left
 * to the input, which marks dispatch when it passes it; focused typing draws no pointer.
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
  const left = () =>
    Math.min(
      ends - Date.now(),
      gate.deadline === undefined ? Infinity : gate.deadline - performance.now(),
    );
  const box =
    left() > 0
      ? await locator.boundingBox({ timeout: Math.max(1, left()) }).catch(() => null)
      : null;
  // A desktop page's viewport is unknown to Playwright; its boxes are still in viewport pixels.
  const viewport = page.viewportSize();
  const point = box && { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // A Stop and resume during the wait leave this action's control behind; its pointer stays.
  gate.check?.();
  if (
    point &&
    left() > 0 &&
    (viewport === null ||
      (point.x >= 0 && point.y >= 0 && point.x <= viewport.width && point.y <= viewport.height))
  )
    await pointer(point, "move");
  return { ...input, timeoutMs: Math.max(1, ends - Date.now()) };
};
