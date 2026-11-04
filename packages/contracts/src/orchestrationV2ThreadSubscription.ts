import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId } from "./baseSchemas.ts";

export const OrchestrationV2SubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  afterSequence: Schema.optionalKey(NonNegativeInt),
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
  acceptBoundedSnapshot: Schema.optionalKey(Schema.Boolean),
  acceptDeferredWork: Schema.optionalKey(Schema.Boolean),
  acceptCompactTurnItems: Schema.optionalKey(Schema.Boolean),
  /** The client restores `*Omitted` bodies from records it already holds. */
  acceptDedupedBodies: Schema.optionalKey(Schema.Boolean),
  acceptCompactIds: Schema.optionalKey(Schema.Boolean),
  /** The client decodes `text-append` items with `@goat/shared/threadTextAppend`. */
  acceptTextAppends: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationV2SubscribeThreadInput = typeof OrchestrationV2SubscribeThreadInput.Type;
