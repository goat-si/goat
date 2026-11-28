import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ComputerUseLeaseCallOutcome = Schema.Struct({
  type: Schema.Literal("callOutcome"),
  controlId: TrimmedNonEmptyString,
  reservationId: Schema.optionalKey(TrimmedNonEmptyString),
  tool: TrimmedNonEmptyString,
  app: Schema.optionalKey(
    Schema.Struct({ id: TrimmedNonEmptyString, name: TrimmedNonEmptyString }),
  ),
  pid: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  targetLabel: Schema.optionalKey(Schema.String),
  verdict: Schema.Literals(["sent", "refused", "unknown_outcome"]),
  refusalCode: Schema.optionalKey(Schema.String),
  typed: Schema.optionalKey(
    Schema.Struct({
      length: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      text: Schema.optionalKey(Schema.String),
      fieldKind: Schema.Literals(["normal", "secure", "unknown"]),
    }),
  ),
});
export type ComputerUseLeaseCallOutcome = typeof ComputerUseLeaseCallOutcome.Type;
