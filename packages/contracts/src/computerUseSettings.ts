import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Computer use fields of `ServerSettings`. */
export const CuaSettingsFields = {
  enableCua: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Built-in skills the person switched off; every other one loads with its capability. Plain
   * names, so a settings file written by a build with more skills still decodes here.
   */
  disabledBuiltInSkills: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
};

/** Computer use fields of `ServerSettingsPatch`. */
export const CuaSettingsPatchFields = {
  enableCua: Schema.optionalKey(Schema.Boolean),
  disabledBuiltInSkills: Schema.optionalKey(Schema.Array(Schema.String)),
};
