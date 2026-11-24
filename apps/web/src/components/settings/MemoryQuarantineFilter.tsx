import { useId } from "react";
import { useGT } from "gt-react";
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
  const gt = useGT();
  return (
    <SettingsRow
      title={gt("Quarantined memories")}
      description={
        searching ? (
          <span id={hintId}>
            {gt("Quarantined memories are excluded from search. Clear search to review them.")}
          </span>
        ) : (
          gt("Review memories that need attention.")
        )
      }
      control={
        <Switch
          aria-label={gt("Include quarantined memories")}
          aria-describedby={searching ? hintId : undefined}
          checked={searching ? false : checked}
          disabled={searching}
          onCheckedChange={onCheckedChange}
        />
      }
    />
  );
}
