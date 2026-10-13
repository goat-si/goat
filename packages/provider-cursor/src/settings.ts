/**
 * Cursor instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * @module provider-cursor/settings
 */
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
    // Off by default like Grok and OpenCode. Users opt in from Settings.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    // Keep V1's CLI configuration when V2 rewrites the shared settings file.
    // V2's Cursor SDK does not use these fields.
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
