import * as Schema from "effect/Schema";

export const NativeGoal = Schema.NullOr(
  Schema.Struct({
    objective: Schema.NonEmptyString,
    status: Schema.Literals(["active", "paused", "complete"]),
    rounds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    reason: Schema.optional(Schema.String),
  }),
);
export const decodeGoal = Schema.decodeUnknownEffect(NativeGoal);
