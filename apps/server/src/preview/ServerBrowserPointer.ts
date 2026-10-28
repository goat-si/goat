import type { Page } from "playwright-core";

import { type PointerReporter, targetLocator } from "./ServerBrowserPage.ts";

/**
 * Moves the agent's pointer over the element an input names before the input reaches it, as a
 * click does. Input into whatever has focus, or an element not in view, draws no pointer.
 */
export const pointAtTarget = async (
  page: Page,
  input: { readonly locator?: string | undefined; readonly selector?: string | undefined },
  pointer: PointerReporter,
) => {
  const locator = targetLocator(page, input);
  const box = locator && (await locator.boundingBox({ timeout: 500 }).catch(() => null));
  const viewport = page.viewportSize();
  if (!box || !viewport) return;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (point.x >= 0 && point.y >= 0 && point.x <= viewport.width && point.y <= viewport.height)
    await pointer(point, "move");
};
