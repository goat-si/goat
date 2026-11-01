import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HandoffSummary } from "./handoff.ts";
import { PreviewTabId } from "./preview.ts";

/** An agent's request that a person finish a step on its browser tab, or on the desktop. */
export const PreviewRequestHandoffInput = Schema.Struct({
  /** What the person should do, in a sentence they can act on. */
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  /** The agent's server browser tab; absent for this thread's computer use control. */
  tabId: Schema.optionalKey(PreviewTabId),
});
export type PreviewRequestHandoffInput = typeof PreviewRequestHandoffInput.Type;

export const PreviewRequestHandoffResult = Schema.Struct({
  kind: Schema.Literal("needs_human"),
  handoff: HandoffSummary,
  /** After the person hands back and GOAT wakes the thread, observe again before acting. */
  next: Schema.Struct({
    after: Schema.Literal("terminal"),
    call: Schema.Literals(["preview_snapshot", "goat_screen_run"]),
  }),
  message: Schema.String,
});
export type PreviewRequestHandoffResult = typeof PreviewRequestHandoffResult.Type;
