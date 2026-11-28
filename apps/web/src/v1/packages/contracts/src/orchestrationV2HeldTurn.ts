import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Stops the Codex turn no run owns that holds the thread's next start; it must be the one shown. */
export const OrchestrationV2StopHeldTurnInput = Schema.Struct({
  threadId: ThreadId,
  nativeTurnId: TrimmedNonEmptyString,
});
export type OrchestrationV2StopHeldTurnInput = typeof OrchestrationV2StopHeldTurnInput.Type;

export const OrchestrationV2StopHeldTurnResult = Schema.Struct({
  /**
   * `stopped`: the turn ended; the message starts unless another Codex turn still holds the
   * thread, which the thread then names. `stopping`: Codex took the stop but
   * has not reported the end yet; the message starts when it does. `none`: that turn no longer
   * holds the thread as a turn no run owns, so nothing was stopped.
   */
  outcome: Schema.Literals(["stopped", "stopping", "none"]),
});
export type OrchestrationV2StopHeldTurnResult = typeof OrchestrationV2StopHeldTurnResult.Type;

export class OrchestrationV2StopHeldTurnError extends Schema.TaggedError<OrchestrationV2StopHeldTurnError>()(
  "OrchestrationV2StopHeldTurnError",
  {
    threadId: ThreadId,
    /** Why, in words a person can act on. */
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail ?? "Could not stop the Codex turn this message waits for.";
  }
}
