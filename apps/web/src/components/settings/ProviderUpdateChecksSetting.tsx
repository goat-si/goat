import { DEFAULT_UNIFIED_SETTINGS } from "@goat/contracts/settings";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
export function ProviderUpdateChecksSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["enableProviderUpdateChecks"]}
      {...searchableSetting("provider-update-checks")}
      description="Check installed provider CLIs for newer available versions and fetch model catalog updates. When off, new models may not appear."
      resetAction={
        settings.enableProviderUpdateChecks !==
        DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
          <SettingResetButton
            label="provider update checks"
            onClick={() =>
              updateSettings({
                enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["enableProviderUpdateChecks"]}
          checked={settings.enableProviderUpdateChecks}
          onCheckedChange={(checked) =>
            updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
          }
          aria-label="Check provider versions"
        />
      }
    />
  );
}
