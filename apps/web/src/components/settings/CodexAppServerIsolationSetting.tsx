import {
  CODEX_APP_SERVER_ISOLATION_DEFAULT,
  type CodexAppServerIsolation,
  DEFAULT_UNIFIED_SETTINGS,
} from "@goat/contracts/settings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const ISOLATION_LABELS: Record<CodexAppServerIsolation, string> = {
  thread: "One per thread",
  shared: "Shared",
};

const codexAppServerIsolationLabel = (value: CodexAppServerIsolation) =>
  value === CODEX_APP_SERVER_ISOLATION_DEFAULT
    ? `${ISOLATION_LABELS[value]} (default)`
    : ISOLATION_LABELS[value];

export function CodexAppServerIsolationSetting() {
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
      {...searchableSetting("codex-app-server-isolation")}
      serverScoped
      settingKeys={["codexAppServerIsolation"]}
      description="Give each new Codex thread its own app-server, so a crash or restart of one stops only that thread. Each process uses more memory. Existing threads keep their current process."
      status={
        !supported
          ? "All selected environments must support separate Codex app-servers."
          : undefined
      }
      resetAction={
        supported &&
        settings.codexAppServerIsolation !== DEFAULT_UNIFIED_SETTINGS.codexAppServerIsolation ? (
          <SettingResetButton
            label="Codex app-servers"
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
          <SelectTrigger size="sm" className="w-full sm:w-64" aria-label="Codex app-servers">
            <SelectValue>
              {(value: CodexAppServerIsolation | null) =>
                value === null ? "Mixed" : codexAppServerIsolationLabel(value)
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
