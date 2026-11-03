import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const CodexTurnSurvival = Schema.Literals(["off", "restart", "always"]);

export const RestartSettingsFields = {
  continueThreadsAfterServerUpdate: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  codexTurnsSurviveServerStop: CodexTurnSurvival.pipe(
    Schema.withDecodingDefault(Effect.succeed("restart" as const)),
  ),
};

export const RestartSettingsPatchFields = {
  continueThreadsAfterServerUpdate: Schema.optionalKey(Schema.Boolean),
  codexTurnsSurviveServerStop: Schema.optionalKey(CodexTurnSurvival),
};

export const SurvivingRestartFields = {
  survivingRestart: Schema.optional(
    Schema.Struct({ nativeStartedAt: Schema.NullOr(Schema.DateTimeUtc) }),
  ),
};

export const SurvivingRestartJsonFields = {
  survivingRestart: Schema.optional(
    Schema.Struct({ nativeStartedAt: Schema.NullOr(Schema.DateTimeUtcFromString) }),
  ),
};
