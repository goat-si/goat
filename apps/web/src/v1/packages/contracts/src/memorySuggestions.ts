import * as Schema from "effect/Schema";
import { ScopedThreadRef } from "./environment.ts";
import { MemoryFailureCode, MemoryId, MemoryScope, MemorySpaceId } from "./memory.ts";

export const MEMORY_SAVE_SUGGESTION_MAX_ITEMS = 50;
export const MEMORY_SAVE_SUGGESTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const MemorySuggestionsInput = Schema.Struct({ memorySpaceId: MemorySpaceId });
export type MemorySuggestionsInput = typeof MemorySuggestionsInput.Type;

export const MemorySuggestionActionInput = Schema.Struct({
  memorySpaceId: MemorySpaceId,
  suggestionId: MemoryId,
});
export type MemorySuggestionActionInput = typeof MemorySuggestionActionInput.Type;

const metadata = {
  suggestionId: MemoryId,
  origin: ScopedThreadRef,
  scope: MemoryScope,
  lineageComplete: Schema.Boolean,
  reason: MemoryFailureCode,
  state: Schema.Literals(["pending", "accepting"]),
  expiresAt: Schema.Int,
};

export const MemorySuggestionMetadataList = Schema.Array(Schema.Struct(metadata)).check(
  Schema.isMaxLength(MEMORY_SAVE_SUGGESTION_MAX_ITEMS),
);
export const MemorySuggestionList = Schema.Array(
  Schema.Struct({ ...metadata, text: Schema.String }),
).check(Schema.isMaxLength(MEMORY_SAVE_SUGGESTION_MAX_ITEMS));
export type MemorySuggestionList = typeof MemorySuggestionList.Type;
export type MemorySuggestionMetadataList = typeof MemorySuggestionMetadataList.Type;

export const MemorySuggestionAcceptResult = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["accepted", "pending"]) }),
  Schema.Struct({ status: Schema.Literal("refused"), reason: MemoryFailureCode }),
]);
export type MemorySuggestionAcceptResult = typeof MemorySuggestionAcceptResult.Type;

export const MemorySuggestionDismissResult = Schema.Struct({ ok: Schema.Literal(true) });
