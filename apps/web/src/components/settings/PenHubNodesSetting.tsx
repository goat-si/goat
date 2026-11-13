import { DEFAULT_PEN_HUB_NODES } from "@goat/contracts";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** Whether this server lists the other machines of its Pen mesh as hub devices. */
export function PenHubNodesSetting() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("hub-pen-machines")}
      serverScoped
      settingKeys={["penHubNodes"]}
      description="When this server is in a Pen mesh, list every other machine in the mesh under hub devices and remove it when it leaves. It only attaches to a GOAT a machine already has; a phone still needs hub access to open one."
      resetAction={
        settings.penHubNodes !== DEFAULT_PEN_HUB_NODES ? (
          <SettingResetButton
            label="Pen machines as hub devices"
            onClick={() => update({ penHubNodes: DEFAULT_PEN_HUB_NODES })}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["penHubNodes"]}
          checked={settings.penHubNodes}
          aria-label="List Pen machines as hub devices"
          onCheckedChange={(checked) => update({ penHubNodes: Boolean(checked) })}
        />
      }
    />
  );
}
