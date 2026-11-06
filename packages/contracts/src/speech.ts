import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

export const SpeechConfiguration = Schema.Struct({
  modelId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  acceleration: Schema.Union([
    Schema.Literals(["auto", "cpu"]),
    Schema.String.check(Schema.isPattern(/^gpu:.+/), Schema.isMaxLength(500)),
  ]),
});
export type SpeechConfiguration = typeof SpeechConfiguration.Type;

export const DEFAULT_SPEECH_CONFIGURATION: SpeechConfiguration = {
  modelId: "handy-computer/parakeet-unified-en-0.6b-gguf",
  acceleration: "auto",
};

export const SpeechSettingsFields = {
  speech: SpeechConfiguration.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SPEECH_CONFIGURATION)),
  ),
};
export const SpeechSettingsPatchFields = { speech: Schema.optionalKey(SpeechConfiguration) };
