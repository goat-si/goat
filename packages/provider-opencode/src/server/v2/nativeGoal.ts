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

export const isMissingGoal = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "CommandExecutionError" &&
  "message" in error &&
  error.message === "No goal is set.";
