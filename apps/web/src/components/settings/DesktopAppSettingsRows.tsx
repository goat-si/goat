import { CliCommandSettingsRow } from "./CliCommandSettingsRow";
import { TrayIconSettingRow } from "./TrayIconSettingRow";

/** General settings that only the desktop app has. */
export function DesktopAppSettingsRows() {
  return (
    <>
      <TrayIconSettingRow />
      <CliCommandSettingsRow />
    </>
  );
}
