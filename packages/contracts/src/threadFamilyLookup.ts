import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

export const THREAD_FAMILY_LOOKUP_LIMIT = 100;
export const OrchestrationV2GetThreadFamilyInput = Schema.Struct({
  threadId: ThreadId,
  lookupOnly: Schema.optionalKey(Schema.Boolean),
  lookupThreadIds: Schema.optionalKey(
    Schema.Array(ThreadId).check(Schema.isMaxLength(THREAD_FAMILY_LOOKUP_LIMIT)),
  ),
});
export type OrchestrationV2GetThreadFamilyInput = typeof OrchestrationV2GetThreadFamilyInput.Type;
