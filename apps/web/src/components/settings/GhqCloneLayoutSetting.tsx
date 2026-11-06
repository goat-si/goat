import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function GhqCloneLayoutSetting(props: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <SettingsRow
      serverScoped
      settingKeys={["ghqCloneLayout"]}
      {...searchableSetting("ghq-clone-layout")}
      description="Clone into host, owner, and repository folders under the project directory."
      control={
        <ScopedSwitch
          settingKeys={["ghqCloneLayout"]}
          checked={props.checked}
          onCheckedChange={(checked) => props.onChange(Boolean(checked))}
          aria-label="Clone into host folders"
        />
      }
    />
  );
}
