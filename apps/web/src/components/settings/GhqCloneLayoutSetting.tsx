import { useGT } from "gt-react";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow } from "./settingsLayout";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";

export function GhqCloneLayoutSetting(props: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const setting = useTranslatedSearchableSetting();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["ghqCloneLayout"]}
      {...setting("ghq-clone-layout")}
      description={gt(
        "Clone into host, owner, and repository folders under the project directory.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["ghqCloneLayout"]}
          checked={props.checked}
          onCheckedChange={(checked) => props.onChange(Boolean(checked))}
          aria-label={gt("Clone into host folders")}
        />
      }
    />
  );
}
