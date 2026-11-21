import { useId } from "react";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

export function MemoryQuarantineFilter({
  checked,
  searching,
  onCheckedChange,
}: {
  checked: boolean;
  searching: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const hintId = useId();
  return (
    <SettingsRow
      title="Quarantined memories"
      description={
        searching ? (
          <span id={hintId}>Clear search to review quarantined memories.</span>
        ) : (
          "Review memories that need attention."
        )
      }
      control={
        <Switch
          aria-label="Include quarantined memories"
          aria-describedby={searching ? hintId : undefined}
          checked={checked}
          disabled={searching}
          onCheckedChange={onCheckedChange}
        />
      }
    />
  );
}
