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
