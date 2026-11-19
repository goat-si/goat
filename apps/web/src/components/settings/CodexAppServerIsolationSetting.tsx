import { useGT } from "gt-react";
import {
  CODEX_APP_SERVER_ISOLATION_DEFAULT,
  type CodexAppServerIsolation,
  DEFAULT_UNIFIED_SETTINGS,
} from "@goat/contracts/settings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function CodexAppServerIsolationSetting() {
  const gt = useGT();
  const setting = useTranslatedSearchableSetting();
  const codexAppServerIsolationLabel = (value: CodexAppServerIsolation) => {
    const label = value === "thread" ? gt("One per thread") : gt("Shared");
    return value === CODEX_APP_SERVER_ISOLATION_DEFAULT
      ? gt("{label} (default)", { label })
      : label;
  };
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { connectedEnvironments } = useSettingsScope();
  const mixed = useScopedSettingsMixed(["codexAppServerIsolation"]);
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.codexAppServerIsolation === true,
    );
  return (
    <SettingsRow
      {...setting("codex-app-server-isolation")}
      serverScoped
      settingKeys={["codexAppServerIsolation"]}
      description={gt(
        "Give each new Codex thread its own app-server, so a crash or restart of one stops only that thread. Each process uses more memory. Existing threads keep their current process.",
      )}
      status={
        !supported
          ? gt("All selected environments must support separate Codex app-servers.")
          : undefined
      }
      resetAction={
        supported &&
        (mixed ||
          settings.codexAppServerIsolation !== DEFAULT_UNIFIED_SETTINGS.codexAppServerIsolation) ? (
          <SettingResetButton
            label={gt("Codex app-servers")}
            onClick={() =>
              updateSettings({
                codexAppServerIsolation: DEFAULT_UNIFIED_SETTINGS.codexAppServerIsolation,
              })
            }
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : settings.codexAppServerIsolation}
          disabled={!supported}
          onValueChange={(value) => {
            if (value === "thread" || value === "shared")
              updateSettings({ codexAppServerIsolation: value });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-64" aria-label={gt("Codex app-servers")}>
            <SelectValue>
              {(value: CodexAppServerIsolation | null) =>
                value === null ? gt("Mixed") : codexAppServerIsolationLabel(value)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="thread">
              {codexAppServerIsolationLabel("thread")}
            </SelectItem>
            <SelectItem hideIndicator value="shared">
              {codexAppServerIsolationLabel("shared")}
            </SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}
