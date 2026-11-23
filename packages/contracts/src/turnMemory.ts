import * as Schema from "effect/Schema";
import { RunId, ThreadId } from "./baseSchemas.ts";
import { MemoryId, MemoryRevisionId, MemorySpaceId } from "./memory.ts";

export const TurnMemoryInput = Schema.Struct({
  memorySpaceId: MemorySpaceId,
  threadId: ThreadId,
  runId: RunId,
});
export type TurnMemoryInput = typeof TurnMemoryInput.Type;
export const TurnMemoryRef = Schema.Struct({ memoryId: MemoryId, revisionId: MemoryRevisionId });
export const TurnMemoryEvent = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["automatic", "recall"]),
  query: Schema.NullOr(Schema.String),
  items: Schema.Array(
    Schema.Struct({ ...TurnMemoryRef.fields, excerpt: Schema.NullOr(Schema.String) }),
  ),
});
export const TurnMemoryResult = Schema.Struct({
  events: Schema.Array(TurnMemoryEvent),
  truncated: Schema.Boolean,
});
export type TurnMemoryResult = typeof TurnMemoryResult.Type;
