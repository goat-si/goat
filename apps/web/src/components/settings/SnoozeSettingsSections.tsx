import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { SnoozePresetsRow } from "./SnoozePresetsSettings";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** Snooze menu choices and the usage-limit stop behavior, side by side in General settings. */
export function SnoozeSettingsSections() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <SettingsSection id="snooze" title="Snooze">
        <SnoozePresetsRow />
      </SettingsSection>

      <SettingsSection id="usage-limits" title="Usage limits">
        <SettingsRow
          serverScoped
          {...searchableSetting("auto-resume-limited-threads")}
          description="Automatically resume threads when their usage limits reset. You can cancel auto-resume in each thread."
          settingKeys={["autoResumeLimitedThreads"]}
          control={
            <ScopedSwitch
              settingKeys={["autoResumeLimitedThreads"]}
              checked={settings.autoResumeLimitedThreads}
              onCheckedChange={(checked) =>
                updateSettings({ autoResumeLimitedThreads: Boolean(checked) })
              }
              aria-label="Resume after usage limits"
            />
          }
        />
        <SettingsRow
          serverScoped
          {...searchableSetting("snooze-limited-threads")}
          description="Snooze threads until their usage limits reset. Enable auto-resume to continue the agent after the reset."
          settingKeys={["snoozeLimitedThreads"]}
          control={
            <ScopedSwitch
              settingKeys={["snoozeLimitedThreads"]}
              checked={settings.snoozeLimitedThreads}
              onCheckedChange={(checked) =>
                updateSettings({ snoozeLimitedThreads: Boolean(checked) })
              }
              aria-label="Snooze until limits reset"
            />
          }
        />
      </SettingsSection>
    </>
  );
}
