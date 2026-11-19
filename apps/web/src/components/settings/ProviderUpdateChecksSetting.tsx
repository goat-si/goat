import { useGT } from "gt-react";
import { DEFAULT_UNIFIED_SETTINGS } from "@goat/contracts/settings";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
export function ProviderUpdateChecksSetting() {
  const setting = useTranslatedSearchableSetting();
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["enableProviderUpdateChecks"]}
      {...setting("provider-update-checks")}
      description={gt(
        "Check installed provider CLIs for newer available versions and fetch model catalog updates. When off, new models may not appear.",
      )}
      resetAction={
        settings.enableProviderUpdateChecks !==
        DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
          <SettingResetButton
            label={gt("provider update checks")}
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
          aria-label={gt("Check provider versions")}
        />
      }
    />
  );
}
