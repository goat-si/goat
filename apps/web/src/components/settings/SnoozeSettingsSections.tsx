import { useGT } from "gt-react";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import { SnoozePresetsRow } from "./SnoozePresetsSettings";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** Snooze menu choices and the usage-limit stop behavior, side by side in General settings. */
export function SnoozeSettingsSections() {
  const setting = useTranslatedSearchableSetting();
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <SettingsSection id="snooze" title={gt("Snooze")}>
        <SnoozePresetsRow />
      </SettingsSection>

      <SettingsSection id="usage-limits" title={gt("Usage limits")}>
        <SettingsRow
          serverScoped
          {...setting("auto-resume-limited-threads")}
          description={gt(
            "Automatically resume threads when their usage limits reset. You can cancel auto-resume in each thread.",
          )}
          settingKeys={["autoResumeLimitedThreads"]}
          control={
            <ScopedSwitch
              settingKeys={["autoResumeLimitedThreads"]}
              checked={settings.autoResumeLimitedThreads}
              onCheckedChange={(checked) =>
                updateSettings({ autoResumeLimitedThreads: Boolean(checked) })
              }
              aria-label={gt("Resume after usage limits")}
            />
          }
        />
        <SettingsRow
          serverScoped
          {...setting("snooze-limited-threads")}
          description={gt(
            "Snooze threads until their usage limits reset. Enable auto-resume to continue the agent after the reset.",
          )}
          settingKeys={["snoozeLimitedThreads"]}
          control={
            <ScopedSwitch
              settingKeys={["snoozeLimitedThreads"]}
              checked={settings.snoozeLimitedThreads}
              onCheckedChange={(checked) =>
                updateSettings({ snoozeLimitedThreads: Boolean(checked) })
              }
              aria-label={gt("Snooze until limits reset")}
            />
          }
        />
      </SettingsSection>
    </>
  );
}
