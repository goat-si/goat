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

export const CodexAppServerIsolation = Schema.Literals(["thread", "shared"]);
export type CodexAppServerIsolation = typeof CodexAppServerIsolation.Type;
/** The shipped default; it changes where new provider threads open, never existing ones. */
export const CODEX_APP_SERVER_ISOLATION_DEFAULT: CodexAppServerIsolation = "shared";

export const CodexAppServerSettingsFields = {
  codexAppServerIsolation: CodexAppServerIsolation.pipe(
    Schema.withDecodingDefault(Effect.succeed(CODEX_APP_SERVER_ISOLATION_DEFAULT)),
  ),
};

export const CodexAppServerSettingsPatchFields = {
  codexAppServerIsolation: Schema.optionalKey(CodexAppServerIsolation),
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
