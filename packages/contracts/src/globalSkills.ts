import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const GOAT_SKILL_SCOPE = "goat";
export const GOAT_SKILL_NAME_PREFIX = "goat:";
export const isGoatSkillName = (name: string): boolean => name.startsWith(GOAT_SKILL_NAME_PREFIX);

export const GoatGlobalSkillSettingsFields = {
  disabledGlobalSkills: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
};
export const GoatGlobalSkillSettingsPatchFields = {
  disabledGlobalSkills: Schema.optionalKey(Schema.Array(Schema.String)),
};
