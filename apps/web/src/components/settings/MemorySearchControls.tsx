import { useGT } from "gt-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

export function MemorySearchControls({
  value,
  canClear,
  onChange,
  onSearch,
  onClear,
}: {
  value: string;
  canClear: boolean;
  onChange: (value: string) => void;
  onSearch: () => void;
  onClear: () => void;
}) {
  const gt = useGT();
  const label = gt("Search memories");
  return (
    <SettingsRow
      title={label}
      control={
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSearch();
          }}
        >
          <Input
            aria-label={label}
            placeholder={label}
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
          <Button type="submit" size="sm" variant="outline">
            {gt("Search")}
          </Button>
          {canClear ? (
            <Button type="button" size="sm" variant="ghost" onClick={onClear}>
              {gt("Clear search")}
            </Button>
          ) : null}
        </form>
      }
    />
  );
}

export function MemoryRecordsError({
  searching,
  error,
  onRetry,
}: {
  searching: boolean;
  error: string;
  onRetry: () => void;
}) {
  const gt = useGT();
  return (
    <SettingsRow
      title={searching ? gt("Could not load memories") : "Could not load memories"}
      description={<span role="alert">{error}</span>}
      control={
        <Button size="sm" variant="outline" onClick={onRetry}>
          {searching ? gt("Retry") : "Retry"}
        </Button>
      }
    />
  );
}
