import * as Schema from "effect/Schema";

/**
 * Only what the model check and placement need from orchestrator_capabilities, so newer fields
 * never break it. An older GOAT may omit driverKind or canRunChildTask; its accounts are then
 * never swapped.
 */
export const OfferedProviders = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      providerInstanceId: Schema.String,
      driverKind: Schema.optional(Schema.String),
      displayName: Schema.optional(Schema.NullOr(Schema.String)),
      /** False for an account that cannot run work now, such as one signed out or disabled. */
      canRunChildTask: Schema.optional(Schema.Boolean),
      models: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  ),
});
export type OfferedProviders = typeof OfferedProviders.Type;
export const decodeOffered = Schema.decodeUnknownEffect(OfferedProviders);
