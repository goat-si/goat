import { MemoryChangeSignal } from "@goat/contracts";
import {
  applyMemoryChange,
  emptyMemoryExposure,
  type MemoryExposure,
} from "@goat/client-runtime/state/memory";
import * as Schema from "effect/Schema";

const decodeSignal = Schema.decodeUnknownSync(MemoryChangeSignal);

/** Applies one body-free change signal to a space's exposure, as the shared subscription does. */
export function withMemorySignal(
  exposure: MemoryExposure,
  memorySpaceId: string,
  kind: MemoryChangeSignal["kind"],
  memoryId?: string,
): MemoryExposure {
  return applyMemoryChange(
    exposure,
    decodeSignal({
      memorySpaceId,
      projectionWatermark: 1,
      kind,
      ...(kind === "reset" ? {} : { memoryId }),
    }),
  );
}

/** A space's exposure after the subscription's first reset: ready, nothing changed yet. */
export const readyMemoryExposure = (memorySpaceId: string) =>
  withMemorySignal(emptyMemoryExposure(), memorySpaceId, "reset");
