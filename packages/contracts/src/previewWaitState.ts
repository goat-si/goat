import { Schema } from "effect";

/** Conditions a tab wait can add to its one target element; each needs a locator or selector. */
export const PreviewWaitStateFields = {
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Needs locator or selector. Waits until the one match is enabled (true) or disabled.",
  }),
  value: Schema.optional(Schema.String).annotate({
    description:
      "Needs locator or selector. The one match's form value, or else its trimmed text, exactly.",
  }),
  checked: Schema.optional(Schema.Boolean).annotate({
    description:
      "Needs locator or selector. The one match's checked state; other elements never match.",
  }),
  selected: Schema.optional(Schema.Boolean).annotate({
    description:
      "Needs locator or selector. An option's or aria-selected state, else its checked state.",
  }),
};

const STATE_KEYS = ["enabled", "value", "checked", "selected"] as const;

/** Why a wait's state or element conditions cannot hold, or undefined when they can. */
export const waitStateConflict = (input: {
  readonly selector?: string | undefined;
  readonly locator?: string | undefined;
  readonly state?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly value?: string | undefined;
  readonly checked?: boolean | undefined;
  readonly selected?: boolean | undefined;
}): string | undefined => {
  const element = STATE_KEYS.some((key) => input[key] !== undefined);
  if (
    (input.state !== undefined || element) &&
    input.selector === undefined &&
    input.locator === undefined
  )
    return "Provide locator or selector when specifying state.";
  if (element && input.state === "detached")
    return "A detached element has no enabled, value, checked or selected state.";
  return undefined;
};
