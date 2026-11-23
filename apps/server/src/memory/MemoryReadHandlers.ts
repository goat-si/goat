import * as Effect from "effect/Effect";
import { WS_METHODS } from "@goat/contracts";
import { memoryLegacyError } from "../mcp/toolkits/memory/handlers.ts";
import type { MemoryAccessError, MemoryService } from "./MemoryService.ts";
import type { MemorySyncService } from "./MemorySyncService.ts";

function inspectBootstrappedTurn(
  memory: Pick<MemoryService["Service"], "inspectTurn">,
  sync: Pick<MemorySyncService["Service"], "requireBootstrap">,
  input: Parameters<MemoryService["Service"]["inspectTurn"]>[0],
  permit: Parameters<MemoryService["Service"]["inspectTurn"]>[1],
) {
  const ready = sync.requireBootstrap(input.memorySpaceId);
  return permit.pipe(
    Effect.andThen(ready),
    Effect.andThen(memory.inspectTurn(input, permit)),
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
    inspectBootstrappedTurn(memory, sync, input, source).pipe(Effect.mapError(memoryLegacyError)),
});
