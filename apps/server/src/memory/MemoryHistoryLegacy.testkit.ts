// Frozen c7d2deceb MemoryHistoryPage and revert union for opt-out compatibility.
import * as Schema from "effect/Schema";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  MemoryOperationId,
  MemoryId,
  MemoryResolutionId,
  MemoryUtcTimestamp,
  MemoryMutationReceipt,
  MemoryLocalAvailability,
  MemoryRevision,
  MemoryPayload,
  MemoryResolution,
  MemoryResolutionPayload,
  MemoryTombstone,
  MemoryReportDelivery,
  MEMORY_PAGE_MAX_UTF8_BYTES,
} from "@goat/contracts";
const utf8 = (s: string) => new TextEncoder().encode(s).length;
const jsonBytes = (value: unknown) => utf8(JSON.stringify(value));
const bounded = <S extends Schema.Top>(schema: S, max: number) =>
  schema.check(
    Schema.makeFilter((value) => jsonBytes(value) <= max, {
      expected: `at most ${max} encoded UTF-8 bytes`,
    }),
  );
const array = <S extends Schema.Top>(schema: S, max = 100, min = 0) =>
  Schema.Array(schema).check(
    Schema.makeFilter((values) => values.length >= min && values.length <= max),
  );
// Effect 4 annotations cannot set parse options. A declaration keeps strict parsing
// at the schema boundary, including flipped (encode) and type-only (.make) codecs.
const strictSchema = <S extends Schema.Constraint>(schema: S) =>
  Schema.declareConstructor<S["Type"], S["Encoded"]>()(
    [schema],
    ([codec]) => {
      const decode = SchemaParser.decodeUnknownEffect(codec);
      return (input, _ast, options) => decode(input, { ...options, onExcessProperty: "error" });
    },
    {
      toCodec: ([codec]) => new SchemaAST.Link(codec.ast, SchemaTransformation.passthrough()),
      // All memory Encoded values already use JSON. Do not insert a permissive
      // struct parser ahead of this declaration when RPC derives its JSON codec.
      toCodecJson: () => undefined,
    },
  );
const struct = <F extends Schema.Struct.Fields>(fields: F) => {
  const schema = Schema.Struct(fields);
  // Effect's empty struct parser only rejects nullish values and preserves all others.
  return strictSchema(
    Object.keys(fields).length === 0
      ? schema.check(
          Schema.makeFilter(
            (value) =>
              typeof value === "object" &&
              value !== null &&
              !Array.isArray(value) &&
              Reflect.ownKeys(value).length === 0,
            { expected: "an object with no own keys" },
          ),
        )
      : schema,
  );
};
const canonical = Schema.String.check(
  Schema.makeFilter((s) => s.length > 0 && s.trim() === s && Array.from(s).length <= 1024),
);
const revertArms = Schema.Union([
  struct({
    operationId: MemoryOperationId,
    memoryId: MemoryId,
    resolutionId: MemoryResolutionId,
    revertDeadlineUtc: MemoryUtcTimestamp,
    status: Schema.Literal("pending"),
  }),
  struct({
    operationId: MemoryOperationId,
    memoryId: MemoryId,
    resolutionId: MemoryResolutionId,
    revertDeadlineUtc: MemoryUtcTimestamp,
    status: Schema.Literal("accepted"),
    receipt: MemoryMutationReceipt,
    localAvailability: MemoryLocalAvailability,
  }),
  struct({
    operationId: MemoryOperationId,
    memoryId: MemoryId,
    resolutionId: MemoryResolutionId,
    revertDeadlineUtc: MemoryUtcTimestamp,
    status: Schema.Literal("revision_changed"),
  }),
  struct({
    operationId: MemoryOperationId,
    memoryId: MemoryId,
    resolutionId: MemoryResolutionId,
    revertDeadlineUtc: MemoryUtcTimestamp,
    status: Schema.Literal("forgotten"),
  }),
  struct({
    operationId: MemoryOperationId,
    memoryId: MemoryId,
    resolutionId: MemoryResolutionId,
    revertDeadlineUtc: MemoryUtcTimestamp,
    status: Schema.Literal("revert_expired"),
  }),
]);
export type MemoryRevertResult = typeof MemoryRevertResult.Type;
export const MemoryRevertResult = revertArms.check(
  Schema.makeFilter(
    (v) =>
      v.status !== "accepted" ||
      (v.receipt.operationId === v.operationId &&
        v.receipt.memoryId === v.memoryId &&
        v.receipt.revisionId !== null &&
        !v.receipt.pendingSync &&
        v.receipt.outcome === "accepted"),
  ),
);

const revisionPair = struct({ revision: MemoryRevision, payload: Schema.NullOr(MemoryPayload) });
const resolutionPair = struct({
  resolution: MemoryResolution,
  payload: Schema.NullOr(MemoryResolutionPayload),
});

export const MemoryHistoryPage = bounded(
  struct({
    memoryId: MemoryId,
    revisions: array(revisionPair),
    resolutions: array(resolutionPair),
    tombstone: Schema.NullOr(MemoryTombstone),
    reports: array(MemoryReportDelivery),
    revertResults: array(MemoryRevertResult),
    localAvailability: MemoryLocalAvailability,
    nextCursor: Schema.NullOr(canonical),
  }).check(
    Schema.makeFilter(
      (v) =>
        v.revisions.length +
          v.resolutions.length +
          v.reports.length +
          v.revertResults.length +
          (v.tombstone === null ? 0 : 1) <=
          100 &&
        v.revisions.every((r) => r.revision.memoryId === v.memoryId) &&
        v.resolutions.every((r) => r.resolution.memoryId === v.memoryId) &&
        (v.localAvailability.exposure === "visible" ||
          (v.revisions.every((r) => r.payload === null) &&
            v.resolutions.every((r) => r.payload === null))),
    ),
  ),
  MEMORY_PAGE_MAX_UTF8_BYTES,
);
export type MemoryHistoryPage = typeof MemoryHistoryPage.Type;
