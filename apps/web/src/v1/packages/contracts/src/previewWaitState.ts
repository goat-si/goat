import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

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

/** Conditions on the tab rather than one element; only the server browser reads them. */
export const PreviewWaitPageFields = {
  urlGlob: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))).annotate({
    description:
      "The URL matches this glob: * spans any characters, including /, and it is anchored unless it starts or ends with *. Without *, a substring.",
  }),
  download: Schema.optional(Schema.Literal(true)).annotate({
    description:
      "A download that started after this tab's latest agent input has saved; the result names its file. Each wait takes the next one.",
  }),
};

const CONDITION_KEYS = [
  "selector",
  "locator",
  "text",
  "urlIncludes",
  "urlGlob",
  "loadState",
  "download",
] as const;

/** Whether a wait names anything to wait for. */
export const hasWaitCondition = (input: {
  readonly [key in (typeof CONDITION_KEYS)[number]]?: unknown;
}) => CONDITION_KEYS.some((key) => input[key] !== undefined);

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
