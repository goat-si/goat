import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

const ComputerUseCallOwner = {
  controlId: TrimmedNonEmptyString,
  connectionId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
};

// Validation carries only ticket identity; replacement call authority is never accepted.
const ticketValidation = Schema.Struct({
  ...ComputerUseCallOwner,
  action: Schema.Literal("validate"),
  reservationId: TrimmedNonEmptyString,
});
const strictTicketValidation = Schema.declareConstructor<
  typeof ticketValidation.Type,
  typeof ticketValidation.Encoded
>()(
  [ticketValidation],
  ([codec]) => {
    const decode = SchemaParser.decodeUnknownEffect(codec);
    return (input, _ast, options) => decode(input, { ...options, onExcessProperty: "error" });
  },
  {
    toCodec: ([codec]) => new SchemaAST.Link(codec.ast, SchemaTransformation.passthrough()),
    toCodecJson: () => undefined,
  },
);

/**
 * The app a call's pid runs as the driver's answers named it, so the timeline can show that
 * app's name and icon. Display only: scope checks never read it.
 */
export const ComputerUseCallAppLabel = Schema.Struct({
  bundleId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
  name: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
});
export type ComputerUseCallAppLabel = typeof ComputerUseCallAppLabel.Type;

/** A proxy reserves execution before dispatch, and closes a driver generation after cutoff. */
export const ComputerUseCallReservation = Schema.Union([
  Schema.Struct({
    ...ComputerUseCallOwner,
    action: Schema.Literal("reserve"),
    authority: Schema.optionalKey(Schema.Literal("claimBind")),
    callId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    interruptions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    idleEpoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    args: Schema.Unknown,
    foregroundGrantId: Schema.optionalKey(TurnItemId),
    /** The app the proxy judged this call to act on, by the id its scope check uses. */
    app: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
    safetyApps: Schema.optionalKey(
      Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(500))).check(
        Schema.isMaxLength(100),
      ),
    ),
    appLabel: Schema.optionalKey(ComputerUseCallAppLabel),
  }),
  strictTicketValidation,
  Schema.Struct({
    ...ComputerUseCallOwner,
    action: Schema.Literal("release"),
    reservationId: TrimmedNonEmptyString,
    /**
     * The driver answered this call. A driver runs one connection's calls in order, so every
     * earlier call of that connection has ended too (D17).
     */
    completed: Schema.optionalKey(Schema.Boolean),
    /** Nothing of this call reached the app: GOAT or the driver refused it (D17 app lease). */
    notSent: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ ...ComputerUseCallOwner, action: Schema.Literal("close") }),
]);
export type ComputerUseCallReservation = typeof ComputerUseCallReservation.Type;
