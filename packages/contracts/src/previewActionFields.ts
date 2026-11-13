import { Schema } from "effect";

const PreviewKeyModifier = Schema.Literals(["Alt", "Control", "Meta", "Shift"]);

/** Click options GOAT adds to the upstream click input; only the server browser reads them. */
export const PreviewClickModeFields = {
  checked: Schema.optional(Schema.Boolean).annotate({
    description:
      "Set a checkbox, radio or switch to this state: clicks only when it differs, then reads it back. Needs locator or selector.",
  }),
  modifiers: Schema.optional(
    Schema.Array(PreviewKeyModifier).check(Schema.isMaxLength(4)),
  ).annotate({
    description:
      "Keys held during the click, such as Shift for a range or Control/Meta for a new tab.",
  }),
};

/** A wanted checked state needs one element and one left click. */
export const clickModeProblem = Schema.makeFilter(
  (input: {
    readonly checked?: boolean | undefined;
    readonly selector?: string | undefined;
    readonly locator?: string | undefined;
    readonly button?: string | undefined;
    readonly clickCount?: number | undefined;
  }) =>
    input.checked === undefined ||
    ((input.selector !== undefined || input.locator !== undefined) &&
      (input.button ?? "left") === "left" &&
      (input.clickCount ?? 1) === 1) ||
    "checked needs a locator or selector and one left click.",
);

/** One target kind; an element alone is scrolled into view, a point or the page needs a delta. */
export const scrollInputProblem = Schema.makeFilter(
  (input: {
    readonly selector?: string | undefined;
    readonly locator?: string | undefined;
    readonly x?: number | undefined;
    readonly y?: number | undefined;
    readonly deltaX?: number | undefined;
    readonly deltaY?: number | undefined;
  }) => {
    if (input.selector !== undefined && input.locator !== undefined)
      return "Provide at most one of selector or locator.";
    if ((input.x === undefined) !== (input.y === undefined)) return "Provide x and y together.";
    const element = input.selector !== undefined || input.locator !== undefined;
    if (input.x !== undefined && element) return "Provide a point or a locator, not both.";
    return (
      input.deltaX !== undefined ||
      input.deltaY !== undefined ||
      element ||
      "Provide deltaX or deltaY, or a locator to bring into view."
    );
  },
);
