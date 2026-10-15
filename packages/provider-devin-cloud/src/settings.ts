import { TrimmedString, makeProviderSettingsSchema } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const DevinCloudSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    siblingInstanceId: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Devin ACP instance ID",
        description: "Reuse this environment's existing Devin ACP Registry executable and sign-in.",
        providerSettingsForm: {
          placeholder: "ACP Registry instance ID",
          clearWhenEmpty: "persist",
        },
      }),
    ),
  },
  { order: ["siblingInstanceId"] },
);
export type DevinCloudSettings = typeof DevinCloudSettings.Type;

export const DEVIN_MODELS = [
  ["default", "Cloud account default"],
  ["devin-auto", "Fusion"],
  ["devin-ultra", "Ultra"],
  ["devin-2-5", "Normal"],
  ["devin-fast-opus", "Fast"],
  ["devin_lite", "Lite"],
  ["devin-swe-2-low", "SWE-2 Medium"],
  ["devin-swe-2-high", "SWE-2 High"],
  ["devin-swe-2-max", "SWE-2 Max"],
  ["devin-gpt-6-1-sol", "GPT-6.1 Sol (Preview)"],
] as const;
