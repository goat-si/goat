import type { Locator } from "playwright-core";

/** A wait's conditions that must hold together on its one target (see PreviewWaitStateFields). */
interface StateInput {
  readonly enabled?: boolean | undefined;
  readonly value?: string | undefined;
  readonly checked?: boolean | undefined;
  readonly selected?: boolean | undefined;
  readonly state?: string | undefined;
  readonly text?: string | undefined;
  readonly urlIncludes?: string | undefined;
}

/** The element conditions a wait asked for, as its timeout names them. */
export const stateConditions = (input: StateInput): ReadonlyArray<string> =>
  (["enabled", "value", "checked", "selected"] as const).flatMap((key) =>
    input[key] === undefined ? [] : [`${key}=${JSON.stringify(input[key])}`],
  );

/**
 * Whether the one element a strict locator names holds every condition at once, with the wait's
 * visibility, page text and URL: all are read in one page task, so conditions that only hold at
 * different moments never match. A missing, mixed or indeterminate checked or selected state
 * matches neither true nor false.
 */
export const matchesState = async (locator: Locator, input: StateInput, budgetMs: number) => {
  const read = await locator
    .evaluate(
      (element, [text, url]) => {
        type Node = {
          readonly tagName: string;
          readonly value?: unknown;
          readonly checked?: unknown;
          readonly indeterminate?: unknown;
          readonly selected?: unknown;
          readonly type?: unknown;
          readonly textContent: string | null;
          matches(selector: string): boolean;
          closest(selector: string): unknown;
          getAttribute(name: string): string | null;
          getBoundingClientRect(): { readonly width: number; readonly height: number };
        };
        const view = globalThis as unknown as {
          getComputedStyle(node: unknown): { readonly visibility: string };
          readonly location: { readonly href: string };
          readonly document: { readonly body: { readonly innerText: string } | null };
        };
        const node = element as unknown as Node;
        const aria = (name: string) => {
          const said = node.getAttribute(name);
          return said === "true" ? true : said === "false" ? false : null;
        };
        const checkable =
          node.tagName === "INPUT" && (node.type === "checkbox" || node.type === "radio");
        const checked = checkable
          ? node.indeterminate === true
            ? null
            : node.checked === true
          : aria("aria-checked");
        const selected = node.tagName === "OPTION" ? node.selected === true : aria("aria-selected");
        const form = ["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName);
        const box = node.getBoundingClientRect();
        return {
          enabled: !node.matches(":disabled") && node.closest('[aria-disabled="true"]') === null,
          checked,
          selected: selected ?? checked,
          value:
            form && typeof node.value === "string" ? node.value : (node.textContent ?? "").trim(),
          visible:
            box.width > 0 && box.height > 0 && view.getComputedStyle(node).visibility !== "hidden",
          text: text === null || (view.document.body?.innerText ?? "").includes(text),
          url: url === null || view.location.href.includes(url),
        };
      },
      [input.text ?? null, input.urlIncludes ?? null] as const,
      { timeout: Math.max(1, Math.min(budgetMs, 1_000)) },
    )
    .catch((cause: unknown) => {
      // A hidden wait also holds for a detached target, which has no state to read: not yet.
      if (cause instanceof Error && cause.name === "TimeoutError") return undefined;
      throw cause;
    });
  if (read === undefined) return false;
  const element = (["enabled", "value", "checked", "selected"] as const).every(
    (key) => input[key] === undefined || read[key] === input[key],
  );
  const shown =
    input.state === "visible" ? read.visible : input.state === "hidden" ? !read.visible : true;
  return element && shown && read.text && read.url;
};
