import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

export const ComputerUseHistoryCursor = Schema.Struct({
  recordedAt: Schema.Int,
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export const ComputerUseHistoryInput = Schema.Struct({
  threadId: ThreadId,
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  before: Schema.optionalKey(ComputerUseHistoryCursor),
});
export type ComputerUseHistoryInput = typeof ComputerUseHistoryInput.Type;
export const ComputerUseHistoryEntry = Schema.Struct({
  id: Schema.Int,
  threadId: Schema.String,
  recordedAt: Schema.Int,
  targetKind: Schema.Literals(["app", "tab"]),
  appId: Schema.NullOr(Schema.String),
  appName: Schema.NullOr(Schema.String),
  tabHost: Schema.NullOr(Schema.String),
  method: Schema.String,
  targetLabel: Schema.NullOr(Schema.String),
  verdict: Schema.Literals(["sent", "refused", "unknown_outcome"]),
  refusalCode: Schema.NullOr(Schema.String),
  typedLength: Schema.NullOr(Schema.Int),
  typedText: Schema.NullOr(Schema.String),
});
export const ComputerUseHistoryResult = Schema.Struct({
  entries: Schema.Array(ComputerUseHistoryEntry),
  nextCursor: Schema.NullOr(ComputerUseHistoryCursor),
});
export class ComputerUseHistoryError extends Schema.TaggedError<ComputerUseHistoryError>()(
  "ComputerUseHistoryError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}
