import { ProviderDriverKind } from "@goat/contracts";
import { defineProviderClient } from "@goat/provider-core/client";
import { DevinCloudSettings } from "./settings.ts";

export const devinCloudClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("devinCloud"),
  label: "Devin Cloud",
  executionLocation: "cloud",
  badgeLabel: "Cloud",
  settingsSchema: DevinCloudSettings,
  hasDefaultInstance: false,
});
