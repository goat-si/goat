import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

import { MemoryRevisionId } from "./memory.ts";

/** The instruction and resolved destination frozen before one generation's worker starts. */
export const ChannelTaskBrief = Schema.Struct({
  version: PositiveInt,
  generation: PositiveInt,
  intent: Schema.String.check(Schema.isMaxLength(500)),
  instruction: Schema.String,
  deliveredText: Schema.String,
  scopeIn: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  scopeOut: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  criteria: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  verification: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  context: Schema.Struct({
    notesPath: Schema.optional(Schema.String),
    /** SHA-256 of the notes file at launch; null means no notes were delivered/available. */
    notesRevision: Schema.optional(
      Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
    ),
    skillsPath: Schema.optional(Schema.String),
    memoryRefs: Schema.optional(Schema.Array(Schema.String)),
    files: Schema.optional(Schema.Array(Schema.String)),
  }),
  target: Schema.Struct({
    environmentId: EnvironmentId,
    hostId: Schema.optional(TrimmedNonEmptyString),
    /** Provider instance used for routing; its driver is resolved by the environment. */
    provider: TrimmedNonEmptyString,
    model: TrimmedNonEmptyString,
  }),
  frozenAt: IsoDateTime,
});
export type ChannelTaskBrief = typeof ChannelTaskBrief.Type;

const ExportTimestamp = IsoDateTime.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/),
  Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value)), {
    expected: "a UTC timestamp",
  }),
);

export const ChannelTaskExportInput = Schema.Struct({
  /** UTC terminal event timestamps in the half-open interval [from, to). */
  from: ExportTimestamp,
  to: ExportTimestamp,
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(200))),
  cursor: Schema.optional(
    Schema.String.check(
      Schema.isPattern(/^[0-9]+$/),
      Schema.makeFilter((value: string) => Number.isSafeInteger(Number(value)), {
        expected: "a safe event sequence",
      }),
    ),
  ),
});
export type ChannelTaskExportInput = typeof ChannelTaskExportInput.Type;

export const ChannelTaskExportResult = Schema.Struct({
  jsonl: Schema.String,
  nextCursor: Schema.optional(Schema.String),
});
export type ChannelTaskExportResult = typeof ChannelTaskExportResult.Type;

/** Export-time cumulative thread lineage, including ancestors; non-tracked lists are incomplete. */
export const ChannelTaskMemoryDelivered = Schema.Struct({
  state: Schema.Literals(["tracked", "unknown", "overflow"]),
  revisions: Schema.Array(MemoryRevisionId).check(Schema.isMaxLength(100)),
});
export type ChannelTaskMemoryDelivered = typeof ChannelTaskMemoryDelivered.Type;
