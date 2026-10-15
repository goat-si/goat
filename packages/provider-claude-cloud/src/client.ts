import { ClaudeCloudSettings, ProviderDriverKind } from "@goat/contracts";
import { defineProviderClient } from "@goat/provider-core/client";

export const claudeCloudClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("claudeCloud"),
  label: "Claude Cloud",
  executionLocation: "cloud",
  badgeLabel: "Cloud",
  settingsSchema: ClaudeCloudSettings,
  hasDefaultInstance: true,
});
