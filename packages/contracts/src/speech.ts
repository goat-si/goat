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

export const SpeechModelRequest = Schema.Struct({
  modelId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
});
export const SpeechModelLinkRequest = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
});
export const SpeechBenchmarkTier = Schema.Literals(["cpu", "accelerated"]);
export type SpeechBenchmarkTier = typeof SpeechBenchmarkTier.Type;
export const SpeechBenchmark = Schema.Struct({
  cpu: Schema.NullOr(Schema.Finite),
  accelerated: Schema.NullOr(Schema.Finite),
});
export type SpeechBenchmark = typeof SpeechBenchmark.Type;
export function speechBenchmarkTiers(
  acceleration: SpeechConfiguration["acceleration"] | undefined,
): readonly SpeechBenchmarkTier[] {
  if (acceleration === "cpu") return ["cpu"];
  if (acceleration?.startsWith("gpu:")) return ["accelerated"];
  return ["cpu", "accelerated"];
}
export const SpeechModelList = Schema.Struct({
  /** Absent from servers that cannot link existing model files. */
  supportsModelLinking: Schema.optionalKey(Schema.Boolean),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      description: Schema.String,
      size: Schema.Number,
      installed: Schema.Boolean,
      selected: Schema.Boolean,
      linkedFrom: Schema.optionalKey(Schema.String),
      recommended: Schema.optionalKey(Schema.Boolean),
      benchmark: Schema.optionalKey(SpeechBenchmark),
    }),
  ),
});
export const SpeechMutationResult = Schema.Struct({ ok: Schema.Literal(true) });
