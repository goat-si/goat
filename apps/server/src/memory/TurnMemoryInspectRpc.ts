import * as Effect from "effect/Effect";
import type { MemoryService } from "./MemoryService.ts";
import type { MemorySyncService } from "./MemorySyncService.ts";

export function inspectBootstrappedTurn(
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
