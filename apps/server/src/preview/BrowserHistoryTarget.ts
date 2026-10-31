import type { Page } from "playwright-core";
import { targetLocator } from "./ServerBrowserPage.ts";

export async function browserHistoryTarget(
  page: Page,
  input: { readonly selector?: string | undefined; readonly locator?: string | undefined },
) {
  try {
    const locator = targetLocator(page, input);
    if (locator === null) return undefined;
    const label = await locator.evaluate(
      (element, singleFrame) => {
        const tag = element.tagName.toLowerCase();
        if (
          tag === "input" ||
          tag === "textarea" ||
          (element instanceof HTMLElement && element.isContentEditable)
        )
          return "textbox";
        const role =
          element.getAttribute("role")?.toLowerCase() ??
          (tag === "button" ? "button" : tag === "a" ? "link" : undefined);
        if (role !== "button" && role !== "link") return undefined;
        if (
          !singleFrame ||
          element.getRootNode() !== element.ownerDocument ||
          element.ownerDocument.querySelector("input, textarea, [contenteditable]")
        )
          return role;
        const name = element.getAttribute("aria-label")?.trim();
        return name ? `${role}: ${name}` : role;
      },
      page.frames().length === 1,
      { timeout: 1000 },
    );
    return label?.slice(0, 80);
  } catch {
    return undefined;
  }
}
