import * as Schema from "effect/Schema";

import { HandoffSummary } from "./handoff.ts";

/** When the agent makes the next call: after a person approves, finishes a step, or enters input. */
export const NeedsHumanAfter = Schema.Literals(["approval", "terminal", "input"]);
export type NeedsHumanAfter = typeof NeedsHumanAfter.Type;

/**
 * The shared needs_human arm (docs/internals/agent-surface.md, Result envelope): a handoff a
 * person can act on, and the registered tool the agent calls once they have. Each tool names its
 * own continuation, so a schema never offers a call that tool does not mean.
 */
export const needsHumanFields = <const After extends NeedsHumanAfter, const Call extends string>(
  after: After,
  call: Call,
) => ({
  kind: Schema.Literal("needs_human"),
  handoff: HandoffSummary,
  next: Schema.Struct({ after: Schema.Literal(after), call: Schema.Literal(call) }),
});
