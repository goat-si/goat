import { SettingsSwitchRow } from "../components/SettingsSwitchRow";

export function ComputerUseHistoryRetentionRow(props: {
  readonly value: boolean | null;
  readonly disabled: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <SettingsSwitchRow
      icon="desktopcomputer"
      label="Keep typed text"
      subtitle="Keep text only when GOAT confirms it reached a normal browser field. Desktop typing and protected fields stay redacted."
      value={props.value}
      disabled={props.disabled}
      onValueChange={props.onChange}
    />
  );
}
