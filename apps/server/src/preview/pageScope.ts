import { previewReadRefusalMessage, type PreviewAutomationScope } from "@goat/contracts";
import type { Locator, Page } from "playwright-core";
import { ServerBrowserOperationError } from "./browserOperationError.ts";
import { targetLocator } from "./ServerBrowserPage.ts";

export const readFailure = (
  reason:
    | "scope_not_found"
    | "scope_ambiguous"
    | "stale_ref"
    | "revision_required"
    | "pageChanged"
    | "output_limit",
) =>
  new ServerBrowserOperationError("PreviewAutomationReadError", previewReadRefusalMessage(reason), {
    reason,
  });

/**
 * Page-side check that a scope root or anything it is composed into (slots, shadow hosts,
 * closed details) is hidden. Stops at its document; scopeHidden walks embedding frames.
 */
const HIDDEN_IN_DOCUMENT = `node => {
  for (let element = node; element; ) {
    if (element.nodeType === 1) {
      const style = element.ownerDocument.defaultView.getComputedStyle(element);
      if (element.hasAttribute('hidden') || element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true' || style.display === 'none' || (element === node && style.visibility === 'hidden')) return true;
    }
    const parent = element.assignedSlot || element.parentElement || (element.parentNode && element.parentNode.host) || null;
    if (parent && parent.localName === 'details' && !parent.hasAttribute('open') && !(element.localName === 'summary' && element.parentElement === parent)) return true;
    element = parent;
  }
  return false;
}`;
const hiddenInDocument = new Function("node", `return (${HIDDEN_IN_DOCUMENT})(node);`) as (
  node: unknown,
) => boolean;

/** True when the scope root, an ancestor, or any frame element embedding it is hidden. */
export const scopeHidden = async (scope: Locator): Promise<boolean> => {
  const handle = await scope.elementHandle({ timeout: 2_000 });
  if (!handle) throw readFailure("scope_not_found");
  try {
    if (await handle.evaluate(hiddenInDocument)) return true;
    let frame = await handle.ownerFrame();
    while (frame?.parentFrame()) {
      const element = await frame.frameElement();
      try {
        if (await element.evaluate(hiddenInDocument)) return true;
      } finally {
        void element.dispose().catch(() => undefined);
      }
      frame = frame.parentFrame();
    }
    return false;
  } finally {
    void handle.dispose().catch(() => undefined);
  }
};

export const resolvePageScope = async (page: Page, scope?: PreviewAutomationScope) => {
  if (!scope) return page.locator("body");
  let locator;
  try {
    locator = targetLocator(page, {
      locator: scope.ref === undefined ? scope.selector : `aria-ref=${scope.ref}`,
    });
  } catch {
    throw readFailure("stale_ref");
  }
  if (!locator) throw readFailure("scope_not_found");
  const count = await locator.count();
  if (count === 0) throw readFailure(scope.ref === undefined ? "scope_not_found" : "stale_ref");
  if (count > 1) throw readFailure("scope_ambiguous");
  return locator;
};
