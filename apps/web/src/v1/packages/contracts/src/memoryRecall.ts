import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";
import { ScopedThreadRef } from "./environment.ts";
import {
  MEMORY_PAGE_MAX_UTF8_BYTES,
  MemoryAssertionKind,
  MemoryId,
  MemoryRevisionId,
  MemoryScope,
  MemorySpaceId,
  MemoryUtcTimestamp,
} from "./memory.ts";

export const MemoryRecallInput = Schema.Struct({
  memorySpaceId: Schema.optionalKey(MemorySpaceId),
  query: Schema.String.check(
    Schema.makeFilter((s) => s.length > 0 && s === s.trim() && Array.from(s).length <= 500),
  ),
  limit: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(20),
    ),
  ),
});
export type MemoryRecallInput = typeof MemoryRecallInput.Type;

export const MemoryRecallHit = Schema.Struct({
  memoryId: MemoryId,
  revisionId: MemoryRevisionId,
  scope: MemoryScope,
  assertionKind: MemoryAssertionKind,
  createdAtUtc: MemoryUtcTimestamp,
  sourceThread: Schema.optionalKey(ScopedThreadRef),
  text: Schema.String,
  relation: Schema.Literals(["this_thread", "project_thread", "project", "user"]),
  score: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  match: Schema.Literals(["strong", "weak"]),
  matchedTerms: Schema.Array(Schema.String),
});
export type MemoryRecallHit = typeof MemoryRecallHit.Type;

export const MemoryRecallCoverage = Schema.Struct({
  status: Schema.Literals(["complete", "partial", "unavailable"]),
  eligibleItems: NonNegativeInt,
  scannedItems: NonNegativeInt,
  unindexedItems: NonNegativeInt,
  relatedThreadsTruncated: Schema.Boolean,
  projectScopeUnavailable: Schema.optionalKey(Schema.Boolean),
  projectionWatermark: NonNegativeInt,
});
export type MemoryRecallCoverage = typeof MemoryRecallCoverage.Type;

export const MemoryRecallResult = Schema.Struct({
  memorySpaceId: MemorySpaceId,
  projectionWatermark: NonNegativeInt,
  terms: Schema.Array(Schema.String),
  items: Schema.Array(MemoryRecallHit).check(Schema.makeFilter((items) => items.length <= 20)),
  indexCoverage: MemoryRecallCoverage,
  note: Schema.optionalKey(Schema.String),
}).check(
  Schema.makeFilter(
    (value) =>
      value.indexCoverage.projectionWatermark === value.projectionWatermark &&
      (value.indexCoverage.status !== "unavailable" || value.items.length === 0) &&
      new TextEncoder().encode(JSON.stringify(value)).length <= MEMORY_PAGE_MAX_UTF8_BYTES,
  ),
);
export type MemoryRecallResult = typeof MemoryRecallResult.Type;
