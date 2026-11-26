import * as Effect from "effect/Effect";
import { WS_METHODS } from "@goat/contracts";
import { memoryLegacyError } from "../mcp/toolkits/memory/handlers.ts";
import type { MemoryAccessError, MemoryService, MemoryServiceError } from "./MemoryService.ts";
import type { MemorySyncService } from "./MemorySyncService.ts";

function readBootstrapped<A>(
  operation: Effect.Effect<A, MemoryServiceError>,
  sync: Pick<MemorySyncService["Service"], "requireBootstrap">,
  input: Pick<Parameters<MemoryService["Service"]["inspectTurn"]>[0], "memorySpaceId">,
  permit: Parameters<MemoryService["Service"]["inspectTurn"]>[1],
) {
  const ready = sync.requireBootstrap(input.memorySpaceId);
  return permit.pipe(
    Effect.andThen(ready),
    Effect.andThen(operation),
    Effect.tap(() => ready),
    Effect.tap(() => permit),
  );
}

export const makeMemoryReadHandlers = (
  memory: MemoryService["Service"],
  sync: MemorySyncService["Service"],
  read: Effect.Effect<void, MemoryAccessError>,
  source: Effect.Effect<void, MemoryAccessError>,
) => ({
  [WS_METHODS.memoryRead]: (input: Parameters<MemoryService["Service"]["read"]>[0]) =>
    memory.read(input, read).pipe(Effect.mapError(memoryLegacyError)),
  [WS_METHODS.memoryHistory]: (input: Parameters<MemoryService["Service"]["history"]>[0]) =>
    memory.history(input, read).pipe(Effect.mapError(memoryLegacyError)),
  [WS_METHODS.memoryReadSource]: (input: Parameters<MemoryService["Service"]["readSource"]>[0]) =>
    memory.readSource(input, source).pipe(Effect.mapError(memoryLegacyError)),
  [WS_METHODS.memoryTurnInspect]: (input: Parameters<MemoryService["Service"]["inspectTurn"]>[0]) =>
    readBootstrapped(memory.inspectTurn(input, source), sync, input, source).pipe(
      Effect.mapError(memoryLegacyError),
    ),
  [WS_METHODS.memoryThreadPreference]: (
    input: Parameters<MemoryService["Service"]["savedThreadPreference"]>[0],
  ) =>
    readBootstrapped(memory.savedThreadPreference(input, source), sync, input, source).pipe(
      Effect.mapError(memoryLegacyError),
    ),
});
