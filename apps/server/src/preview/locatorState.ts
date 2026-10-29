import type { Locator } from "playwright-core";

/** A wait's element conditions on its one target (see PreviewWaitStateFields). */
interface StateInput {
  readonly enabled?: boolean | undefined;
  readonly value?: string | undefined;
  readonly checked?: boolean | undefined;
  readonly selected?: boolean | undefined;
}

/** The element conditions a wait asked for, as its timeout names them. */
export const stateConditions = (input: StateInput): ReadonlyArray<string> =>
  (["enabled", "value", "checked", "selected"] as const).flatMap((key) =>
    input[key] === undefined ? [] : [`${key}=${JSON.stringify(input[key])}`],
  );

/**
 * Whether the one element a strict locator names holds every condition at once: they are read
 * together in one page task, so conditions that only alternate never match. An element without a
 * checked or selected state never matches one.
 */
export const matchesState = async (locator: Locator, input: StateInput, budgetMs: number) => {
  const state = await locator.evaluate(
    (element) => {
      type Node = {
        readonly tagName: string;
        readonly value?: unknown;
        readonly checked?: unknown;
        readonly selected?: unknown;
        readonly type?: unknown;
        readonly textContent: string | null;
        matches(selector: string): boolean;
        closest(selector: string): unknown;
        hasAttribute(name: string): boolean;
        getAttribute(name: string): string | null;
      };
      const node = element as unknown as Node;
      const aria = (name: string) =>
        node.hasAttribute(name) ? node.getAttribute(name) === "true" : undefined;
      const checkable =
        node.tagName === "INPUT" && (node.type === "checkbox" || node.type === "radio");
      const checked = checkable ? node.checked === true : aria("aria-checked");
      const selected = node.tagName === "OPTION" ? node.selected === true : aria("aria-selected");
      const form = ["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName);
      return {
        enabled: !node.matches(":disabled") && node.closest('[aria-disabled="true"]') === null,
        checked: checked ?? null,
        selected: selected ?? checked ?? null,
        value:
          form && typeof node.value === "string" ? node.value : (node.textContent ?? "").trim(),
      };
    },
    undefined,
    { timeout: Math.max(1, Math.min(budgetMs, 1_000)) },
  );
  return (["enabled", "value", "checked", "selected"] as const).every(
    (key) => input[key] === undefined || state[key] === input[key],
  );
};
