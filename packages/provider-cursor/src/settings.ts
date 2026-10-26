import {
  CustomModelSetting,
  makeProviderSettingsSchema,
  TrimmedNonEmptyString,
  TrimmedString,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const CursorSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    // Preserve V1 CLI fields when V2's SDK rewrites shared settings.
    binaryPath: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    apiEndpoint: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: [],
  },
);
export type CursorSettings = typeof CursorSettings.Type;

export const CursorCloudSettings = makeProviderSettingsSchema(
  {
    sourceInstanceId: TrimmedNonEmptyString.pipe(
      Schema.withDecodingDefault(Effect.succeed("cursor")),
      Schema.annotateKey({
        title: "Cursor account source",
        description: "Instance ID of the Cursor provider whose sign-in this cloud provider uses.",
        providerSettingsForm: { placeholder: "cursor" },
      }),
    ),
  },
  { order: ["sourceInstanceId"] },
);
export type CursorCloudSettings = typeof CursorCloudSettings.Type;
