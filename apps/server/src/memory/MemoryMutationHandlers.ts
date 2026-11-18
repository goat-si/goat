import {
  WS_METHODS,
  MemoryMutationReceipt,
  type MemoryUpsertInput,
  type MemoryForgetInput,
  type MemorySuggestionActionInput,
  type MemorySuggestionsInput,
} from "@goat/contracts";
import { memoryError } from "../mcp/toolkits/memory/handlers.ts";
import * as Effect from "effect/Effect";
import { canResolveHumanStep, sessionResolver } from "../handoffs/HumanStepAuthority.ts";
import { MemoryAccessError, type MemoryService } from "./MemoryService.ts";
import * as Schema from "effect/Schema";

const personMemorySuggestionPermit = (
  session: Parameters<typeof sessionResolver>[0],
  permit: Effect.Effect<void, MemoryAccessError>,
) =>
  canResolveHumanStep(sessionResolver(session), "person_only")
    ? permit
    : Effect.fail(new MemoryAccessError({ code: "unavailable" }));

const decodeReceipt = Schema.decodeUnknownEffect(MemoryMutationReceipt);

export const makeMemoryMutationHandlers = (
  memory: MemoryService["Service"],
  session: Parameters<typeof sessionResolver>[0],
  read: Effect.Effect<void, MemoryAccessError>,
  write: Effect.Effect<void, MemoryAccessError>,
) => {
  const readPermit = personMemorySuggestionPermit(session, read);
  const writePermit = personMemorySuggestionPermit(session, write);
  const { suggestions } = memory;
  return {
    [WS_METHODS.memoryUpsert]: (input: MemoryUpsertInput) =>
      memory.upsert(input, write).pipe(
        Effect.flatMap((stored) => decodeReceipt(stored.receipt)),
        Effect.mapError(memoryError),
      ),
    [WS_METHODS.memoryForget]: (input: MemoryForgetInput) =>
      memory.forget(input, write).pipe(
        Effect.flatMap((stored) => decodeReceipt(stored.receipt)),
        Effect.mapError(memoryError),
      ),
    [WS_METHODS.memorySuggestionsList]: (input: MemorySuggestionsInput) =>
      suggestions.list(input, readPermit).pipe(Effect.mapError(memoryError)),
    [WS_METHODS.memorySuggestionsAccept]: (input: MemorySuggestionActionInput) =>
      suggestions.accept(input, writePermit).pipe(Effect.mapError(memoryError)),
    [WS_METHODS.memorySuggestionsDismiss]: (input: MemorySuggestionActionInput) =>
      suggestions.dismiss(input, writePermit).pipe(Effect.mapError(memoryError)),
  };
};
