import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

const THREAD_FAMILY_LOOKUP_LIMIT = 100;
export const OrchestrationV2GetThreadFamilyInput = Schema.Struct({
  threadId: ThreadId,
  lookupOnly: Schema.optionalKey(Schema.Boolean),
  lookupThreadIds: Schema.optionalKey(
    Schema.Array(ThreadId).check(Schema.isMaxLength(THREAD_FAMILY_LOOKUP_LIMIT)),
  ),
});
export type OrchestrationV2GetThreadFamilyInput = typeof OrchestrationV2GetThreadFamilyInput.Type;

/**
 * What a lookupOnly read answers for the ids it was asked: live and archived threads, deleted and
 * unknown ids absent. A thread whose project is gone names no project.
 */
export const ThreadLookupAnswer = {
  lookupTitles: Schema.optionalKey(Schema.Record(ThreadId, Schema.String)),
  lookupProjectIds: Schema.optionalKey(Schema.Record(ThreadId, Schema.NullOr(ProjectId))),
};
