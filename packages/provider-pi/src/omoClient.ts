import { ProviderDriverKind } from "@goat/contracts";
import { defineProviderClient } from "@goat/provider-core/client";
import { OmoSettings } from "./omoSettings.ts";

export const omoClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("omo"),
  label: "OmO",
  settingsSchema: OmoSettings,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [
      {
        d: "M2 12a5 5 0 1 1 10 0 5 5 0 0 1-10 0Zm10 0a5 5 0 1 1 10 0 5 5 0 0 1-10 0ZM7 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm10 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
        fillRule: "evenodd",
      },
    ],
  },
});
