import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Hosts the add and publish project pickers offer, by kind. A host without an entry is offered. */
const OfferedSourceControlProviders = Schema.Record(Schema.String, Schema.Boolean);

export const OfferedSourceControlProviderSettingsFields = {
  offeredSourceControlProviders: OfferedSourceControlProviders.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
};
/** Merges per host. */
export const OfferedSourceControlProviderSettingsPatchFields = {
  offeredSourceControlProviders: Schema.optionalKey(OfferedSourceControlProviders),
};
