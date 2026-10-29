import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  RunId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const OrchestrationV2WorkflowAgentTranscriptFields = {
  model: Schema.optional(TrimmedNonEmptyString),
  effort: Schema.optional(TrimmedNonEmptyString),
  speed: Schema.optional(TrimmedNonEmptyString),
  attempt: Schema.optional(NonNegativeInt),
};

export const OrchestrationV2LimitRecovery = Schema.Struct({
  requestId: Schema.optional(CommandId),
  runId: RunId,
  resetAt: IsoDateTime,
  autoResume: Schema.Boolean,
  snooze: Schema.optional(Schema.Boolean),
});
export type OrchestrationV2LimitRecovery = typeof OrchestrationV2LimitRecovery.Type;

export const OrchestrationV2LimitRecoveryUpdate = Schema.Struct({
  runId: RunId,
  resetAt: IsoDateTime,
  autoResume: Schema.optional(Schema.Boolean),
  snooze: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter(
    (update) =>
      update.autoResume !== undefined ||
      update.snooze !== undefined ||
      "A recovery update must include autoResume or snooze.",
  ),
);
export type OrchestrationV2LimitRecoveryUpdate = typeof OrchestrationV2LimitRecoveryUpdate.Type;

/**
 * One line of the thread's latest completed answer, for cards and lists that show where a thread
 * stands without loading it. Absent until a run completes on a server that records it.
 */
export const OrchestrationV2LatestAnswerExcerpt = Schema.optional(
  Schema.String.check(Schema.isMaxLength(160)),
);
