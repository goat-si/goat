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

// Not a checkbox, radio or switch: it has no checked state, so it never matches one.
const checkedOf = (locator: Locator, timeout: number) =>
  locator.isChecked({ timeout }).catch(() => undefined);

const selectedOf = async (locator: Locator, timeout: number) => {
  const own = await locator.evaluate(
    (element) => {
      const node = element as unknown as {
        readonly tagName: string;
        readonly selected?: boolean;
        hasAttribute(name: string): boolean;
        getAttribute(name: string): string | null;
      };
      if (node.tagName === "OPTION") return node.selected === true;
      if (node.hasAttribute("aria-selected")) return node.getAttribute("aria-selected") === "true";
      return null;
    },
    undefined,
    { timeout },
  );
  return own ?? (await checkedOf(locator, timeout));
};

// A form control's value; any other element's trimmed text.
const valueOf = (locator: Locator, timeout: number) =>
  locator
    .inputValue({ timeout })
    .catch(async () => (await locator.textContent({ timeout }))?.trim());

/** Whether the one element a strict locator names holds every condition now. */
export const matchesState = async (locator: Locator, input: StateInput, budgetMs: number) => {
  const timeout = Math.max(1, Math.min(budgetMs, 1_000));
  if (input.enabled !== undefined && (await locator.isEnabled({ timeout })) !== input.enabled)
    return false;
  if (input.checked !== undefined && (await checkedOf(locator, timeout)) !== input.checked)
    return false;
  if (input.selected !== undefined && (await selectedOf(locator, timeout)) !== input.selected)
    return false;
  return input.value === undefined || (await valueOf(locator, timeout)) === input.value;
};
