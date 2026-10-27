import { previewReadRefusalMessage, type PreviewAutomationScope } from "@goat/contracts";
import type { Page } from "playwright-core";
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
 * Page-side check for a scope root that an ancestor hides, crossing shadow and same-origin frame
 * boundaries. innerText of an element that is not rendered falls back to its full text content.
 */
export const HIDDEN_ABOVE = `node => {
  let child = node;
  for (;;) {
    let parent = child.parentElement || (child.parentNode && child.parentNode.host) || null;
    if (!parent && child.parentNode && child.parentNode.nodeType === 9) {
      try { parent = child.parentNode.defaultView.frameElement; } catch { return false; }
    }
    if (!parent) return false;
    const style = parent.ownerDocument.defaultView.getComputedStyle(parent);
    if (parent.hasAttribute('hidden') || parent.hasAttribute('inert') || parent.getAttribute('aria-hidden') === 'true' || style.display === 'none') return true;
    if (parent.localName === 'details' && !parent.hasAttribute('open') && !(child.localName === 'summary' && child.parentElement === parent)) return true;
    child = parent;
  }
}`;

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
