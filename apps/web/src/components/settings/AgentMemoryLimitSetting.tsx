import { useState } from "react";
import { Input } from "../ui/input";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function AgentMemoryLimitSetting() {
  const value = useScopedSettings((settings) => settings.agentMemoryLimitGiB);
  const update = useUpdateScopedSettings();
  const allowed = useScopedSettingsWriteAllowed();
  const [draft, setDraft] = useState(String(value ?? 16));
  const [source, setSource] = useState(value);
  if (source !== value) {
    setSource(value);
    setDraft(String(value ?? 16));
  }
  const commit = () => {
    const parsed = Number(draft);
    if (
      draft !== "" &&
      Number.isInteger(parsed) &&
      parsed >= 0 &&
      parsed <= 1024 &&
      parsed !== value
    )
      update({ agentMemoryLimitGiB: parsed }, { onFailed: () => setDraft(String(value ?? 16)) });
    else setDraft(String(value ?? 16));
  };
  return (
    <SettingsRow
      {...searchableSetting("agent-memory-limit")}
      serverScoped
      settingKeys={["agentMemoryLimitGiB"]}
      description="On macOS, stop an agent that exceeds its limit. Automatic uses half of memory, up to 16 GiB; 0 turns the limit off."
      resetAction={
        value !== null ? (
          <SettingResetButton
            label="agent memory limit"
            onClick={() => update({ agentMemoryLimitGiB: null })}
          />
        ) : null
      }
      control={
        <div className="flex items-center gap-2">
          <span>Automatic</span>
          <ScopedSwitch
            settingKeys={["agentMemoryLimitGiB"]}
            checked={value === null}
            aria-label="Automatic agent memory limit"
            onCheckedChange={(checked) => update({ agentMemoryLimitGiB: checked ? null : 16 })}
          />
          <Input
            size="sm"
            type="number"
            min={0}
            max={1024}
            step={1}
            className="w-24"
            value={value === null ? "" : draft}
            placeholder={value === null ? "Auto" : undefined}
            disabled={!allowed || value === null}
            aria-label="Agent memory limit in GiB"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              } else if (event.key === "Escape") {
                setDraft(String(value ?? 16));
              }
            }}
          />
          <span>GiB</span>
        </div>
      }
    />
  );
}
