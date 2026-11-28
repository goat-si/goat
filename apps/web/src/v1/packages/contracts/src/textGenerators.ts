import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { SettingsSecretValue } from "./secretReference.ts";

export const TextGeneratorKind = Schema.Literals(["openaiCompatible", "anthropic"]);
export const TextGeneratorConfig = Schema.Struct({
  kind: TextGeneratorKind,
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  model: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  baseUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(2048),
    Schema.makeFilter((value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === "http:" || url.protocol === "https:") &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }),
  ),
  apiKey: SettingsSecretValue.check(
    Schema.makeFilter((value) => typeof value !== "string" || value.length <= 8192),
  ).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type TextGeneratorConfig = typeof TextGeneratorConfig.Type;
export const TextGenerators = Schema.Record(ProviderInstanceId, TextGeneratorConfig).check(
  Schema.makeFilter((entries) => Object.keys(entries).length <= 64),
);
