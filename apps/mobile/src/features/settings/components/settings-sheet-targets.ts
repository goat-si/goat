export type GoatSettingsSheetTarget = "SettingsMemory" | "SettingsGoatBot" | "SettingsHubNodes";

export function isGoatSettingsSheetTarget(
  target: SettingsSheetTarget,
): target is GoatSettingsSheetTarget {
  return (
    target === "SettingsMemory" || target === "SettingsGoatBot" || target === "SettingsHubNodes"
  );
}

export type SettingsSheetTarget =
  | GoatSettingsSheetTarget
  | "SettingsEnvironments"
  | "SettingsNotifications"
  | "SettingsThreads"
  | "SettingsAbout"
  | "SettingsArchive"
  | "SettingsAppearance"
  | "SettingsNavigation"
  | "SettingsOrganization"
  | "SettingsProjectOverview"
  | "SettingsEnvironmentNewThreads"
  | "SettingsEnvironmentSourceControl"
  | "SettingsEnvironmentAgentBehavior"
  | "SettingsEnvironmentMaintenance"
  | "SettingsProviderAccounts"
  | "SettingsKeyboard"
  | "SettingsMicrophone"
  | "SettingsFollowUp"
  | "SettingsScheduledTasks"
  | "SettingsProjectGrouping"
  | "SettingsClientStorage"
  | "SettingsDiagnostics"
  | "SettingsOpenSourceLicenses"
  | "SettingsUsage";

export type SettingsLegalDocumentTarget = "SettingsLegal";
