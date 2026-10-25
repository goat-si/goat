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
  /**
   * Threads in full access mode control every app on this host without a computer_use.grant,
   * unattended ones included. Stop, the kill switch and secret-field detection still hold them;
   * a person typing does not pause admitted work.
   */
  cuaFullAccessAutoAdmit: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
};

/** Computer use fields of `ServerSettingsPatch`. */
export const CuaSettingsPatchFields = {
  enableCua: Schema.optionalKey(Schema.Boolean),
  disabledBuiltInSkills: Schema.optionalKey(Schema.Array(Schema.String)),
  cuaFullAccessAutoAdmit: Schema.optionalKey(Schema.Boolean),
};
