import * as Schema from "effect/Schema";
import { isMemoryRevisionOperation, type MemoryOperation } from "./memory.ts";
import { MEMORY_DERIVED_REVISIONS_MAX_V1 } from "./memoryLimits.ts";

export const MEMORY_FLOOR_2 = ["derivedCap1000", "revisionMarks", "scopeMoves"] as const;
export const MemoryFloor2Feature = Schema.Literals(MEMORY_FLOOR_2);
export type MemoryFloor2Feature = typeof MemoryFloor2Feature.Type;

export const supportsMemoryFloor2 = (features: readonly MemoryFloor2Feature[] | undefined) =>
  features?.length === MEMORY_FLOOR_2.length && MEMORY_FLOOR_2.every((f) => features.includes(f));

export const requiresMemoryFloor2 = (operation: MemoryOperation) =>
  operation.kind === "move" ||
  (isMemoryRevisionOperation(operation) &&
    (operation.payload.derivedFromMemoryRevisions.length > MEMORY_DERIVED_REVISIONS_MAX_V1 ||
      operation.revision.provenance.unverified === true ||
      operation.revision.provenance.originThreadId !== undefined ||
      operation.forgetFence !== undefined));
