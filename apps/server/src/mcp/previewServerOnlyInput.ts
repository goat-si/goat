import type { PreviewAutomationOperation } from "@goat/contracts";

/**
 * Whether a request uses a field only the in-process server browser reads. Other hosts can
 * advertise these operations and would drop the field yet still answer, so such requests stay
 * on the server browser.
 */
export const usesServerOnlyInput = (
  operation: PreviewAutomationOperation,
  input: unknown,
): boolean => {
  if (typeof input !== "object" || input === null) return false;
  const has = (key: string) => (input as Record<string, unknown>)[key] !== undefined;
  switch (operation) {
    case "click":
      return has("checked") || has("modifiers");
    case "scroll":
      // An element with no delta is scrolled into view; an older host refuses or ignores that.
      return (has("selector") || has("locator")) && !has("deltaX") && !has("deltaY");
    case "waitFor":
      return has("urlGlob") || has("download");
    default:
      return false;
  }
};
