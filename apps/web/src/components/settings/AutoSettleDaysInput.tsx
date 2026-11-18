import { useState } from "react";
import {
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@goat/contracts/settings";
import { Input } from "../ui/input";
import {
  autoSettleDaysField,
  cancelAutoSettleDaysField,
  commitAutoSettleDaysField,
  editAutoSettleDaysField,
  failAutoSettleDaysField,
  syncAutoSettleDaysField,
} from "./autoSettleDaysField";

export function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number, options: { onFailed: () => void }) => void;
}) {
  const [stored, setField] = useState(() => autoSettleDaysField(value));
  const field = syncAutoSettleDaysField(stored, value);
  if (field !== stored) setField(field);

  const commit = () => {
    const next = commitAutoSettleDaysField(field);
    setField(next.field);
    if (next.submit === null) return;
    const { revision } = next.field;
    onCommit(next.submit, {
      onFailed: () => setField((current) => failAutoSettleDaysField(current, revision)),
    });
  };

  return (
    <Input
      size="sm"
      type="number"
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      className="w-full sm:w-24"
      value={field.draft}
      onChange={(event) => setField(editAutoSettleDaysField(field, event.target.value))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") commit();
        if (event.key === "Escape" && field.dirty) {
          // An unhandled Escape closes the settings page, and the blur that follows would save.
          event.preventDefault();
          event.stopPropagation();
          setField(cancelAutoSettleDaysField(field));
        }
      }}
      aria-label="Days of inactivity before auto-settle"
    />
  );
}
