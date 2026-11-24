import { useGT } from "gt-react";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function KeepAwakeSetting() {
  const gt = useGT();
  const setting = useTranslatedSearchableSetting()("keep-awake-while-agents-work");
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { connectedEnvironments } = useSettingsScope();
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (environment) =>
        environment.serverConfig?.environment.capabilities.keepAwakeWhileAgentsWork === true,
    );
  return (
    <SettingsRow
      {...setting}
      serverScoped
      settingKeys={["keepAwakeWhileAgentsWork"]}
      description={gt(
        "Prevent idle sleep during active runs on the selected servers. Closing a laptop lid can still put it to sleep.",
      )}
      status={
        supported ? undefined : gt("All selected connected servers must support this setting.")
      }
      control={
        <ScopedSwitch
          settingKeys={["keepAwakeWhileAgentsWork"]}
          checked={settings.keepAwakeWhileAgentsWork}
          disabled={!supported}
          onCheckedChange={(checked) =>
            updateSettings({ keepAwakeWhileAgentsWork: Boolean(checked) })
          }
          aria-label={setting.title}
        />
      }
    />
  );
}
