import {
  WS_METHODS,
  MemoryMutationReceipt,
  MemoryRpcError,
  type MemoryUpsertRpcInput,
  type MemoryForgetRpcInput,
  type MemorySuggestionActionInput,
  type MemorySuggestionsInput,
} from "@goat/contracts";
import { memoryError, memoryLegacyError } from "../mcp/toolkits/memory/handlers.ts";
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

const legacyReceipt = (receipt: typeof MemoryMutationReceipt.Type) => {
  const { capacity, failureCode, ...rest } = receipt;
  if (!failureCode) return receipt;
  const legacy = memoryLegacyError(
    new MemoryRpcError({ code: failureCode, ...(capacity ? { capacity } : {}) }),
  );
  return legacy.code === failureCode ? receipt : { ...rest, failureCode: legacy.code };
};

export const makeMemoryMutationHandlers = (
  memory: MemoryService["Service"],
  session: Parameters<typeof sessionResolver>[0],
  read: Effect.Effect<void, MemoryAccessError>,
  write: Effect.Effect<void, MemoryAccessError>,
) => {
  const readPermit = personMemorySuggestionPermit(session, read);
  const writePermit = personMemorySuggestionPermit(session, write);
  return {
    [WS_METHODS.memoryUpsert]: ({
      includeFailureDetails,
      ...input
    }: typeof MemoryUpsertRpcInput.Type) =>
      memory.upsert(input, write).pipe(
        Effect.flatMap((stored) => decodeReceipt(stored.receipt)),
        Effect.map(includeFailureDetails ? (receipt) => receipt : legacyReceipt),
        Effect.mapError(includeFailureDetails ? memoryError : memoryLegacyError),
      ),
    [WS_METHODS.memoryForget]: ({
      includeFailureDetails,
      ...input
    }: typeof MemoryForgetRpcInput.Type) =>
      memory.forget(input, write).pipe(
        Effect.flatMap((stored) => decodeReceipt(stored.receipt)),
        Effect.map(includeFailureDetails ? (receipt) => receipt : legacyReceipt),
        Effect.mapError(includeFailureDetails ? memoryError : memoryLegacyError),
      ),
    [WS_METHODS.memorySuggestionsList]: (input: MemorySuggestionsInput) =>
      memory.listSuggestions(input, readPermit).pipe(Effect.mapError(memoryError)),
    [WS_METHODS.memorySuggestionsAccept]: (input: MemorySuggestionActionInput) =>
      memory.acceptSuggestion(input, writePermit).pipe(Effect.mapError(memoryError)),
    [WS_METHODS.memorySuggestionsDismiss]: (input: MemorySuggestionActionInput) =>
      memory.dismissSuggestion(input, writePermit).pipe(Effect.mapError(memoryError)),
  };
};
