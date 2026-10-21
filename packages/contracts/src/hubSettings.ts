import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * "hub": cloud launches from any device go to the hub's sign-ins. "auto": the least loaded
 * ready holder, as without a hub.
 */
export const HubCloudHolder = Schema.Literals(["hub", "auto"]);
export type HubCloudHolder = typeof HubCloudHolder.Type;

/** Server settings key `hub`, read on the environment that is the hub. */
export const HubSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  cloudHolder: HubCloudHolder.pipe(Schema.withDecodingDefault(Effect.succeed("hub" as const))),
});
export type HubSettings = typeof HubSettings.Type;

export const HubSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  cloudHolder: Schema.optionalKey(HubCloudHolder),
});
