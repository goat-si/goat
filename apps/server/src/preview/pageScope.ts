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
