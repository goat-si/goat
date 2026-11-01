import type { Page } from "playwright-core";
import { readOnly, type ActionChannel } from "./actionChannel.ts";
import { targetLocator } from "./ServerBrowserPage.ts";

export async function browserHistoryTarget(
  page: Page,
  input: { readonly selector?: string | undefined; readonly locator?: string | undefined },
  channel: ActionChannel,
) {
  try {
    const locator = targetLocator(page, input);
    if (locator === null) return undefined;
    const label = await channel.call(() =>
      locator.evaluate(
        (element, singleFrame) => {
          const tag = element.tagName.toLowerCase();
          if (
            tag === "input" ||
            tag === "textarea" ||
            element.closest("[contenteditable]:not([contenteditable='false'])") !== null
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
          // Page-provided names can repeat typed secrets, so retain only fixed generic labels.
          const safeNames = new Map([
            ["save", "Save"],
            ["cancel", "Cancel"],
            ["close", "Close"],
            ["submit", "Submit"],
            ["ok", "OK"],
            ["next", "Next"],
            ["back", "Back"],
            ["continue", "Continue"],
            ["search", "Search"],
          ]);
          const safeName = name === undefined ? undefined : safeNames.get(name.toLowerCase());
          return safeName === undefined ? role : `${role}: ${safeName}`;
        },
        channel.read(readOnly(() => page.frames().length === 1)),
        { timeout: 1000 },
      ),
    );
    return label?.slice(0, 80);
  } catch {
    return undefined;
  }
}
