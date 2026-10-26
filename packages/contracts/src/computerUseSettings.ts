import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Whether agents may move the person's hardware pointer on this host. */
export const CuaMovePointer = Schema.Literals(["never", "allowed"]);
export type CuaMovePointer = typeof CuaMovePointer.Type;

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
   * No longer read. Every full access run uses every app without approval whatever started it
   * (ADR-0023 D16), so the server ignores this. Kept so settings files and older clients that
   * still send it decode.
   */
  cuaFullAccessAutoAdmit: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * "never" (the default) keeps the person's pointer still: a call that would move it (foreground
   * pointer delivery, a desktop move_cursor) is refused, and agents use element tokens, the
   * keyboard or background clicks. "allowed" lets full access foreground calls move it.
   */
  cuaMovePointer: CuaMovePointer.pipe(Schema.withDecodingDefault(Effect.succeed("never" as const))),
};

/** Computer use fields of `ServerSettingsPatch`. */
export const CuaSettingsPatchFields = {
  enableCua: Schema.optionalKey(Schema.Boolean),
  disabledBuiltInSkills: Schema.optionalKey(Schema.Array(Schema.String)),
  cuaFullAccessAutoAdmit: Schema.optionalKey(Schema.Boolean),
  cuaMovePointer: Schema.optionalKey(CuaMovePointer),
};
