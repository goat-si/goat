import { useGT } from "gt-react";
import { DEFAULT_UNIFIED_SETTINGS } from "@goat/contracts/settings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { CodexAppServerIsolationSetting } from "./CodexAppServerIsolationSetting";
import { KeepAwakeSetting } from "./KeepAwakeSetting";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function RestartContinuationSettings() {
  const setting = useTranslatedSearchableSetting();
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { connectedEnvironments } = useSettingsScope();
  const mixedCodexSurvival = useScopedSettingsMixed(["codexTurnsSurviveServerStop"]);
  const supportsRestartContinuation =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.threadRestartContinuation === true,
    );
  const supportsCodexSurvival =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.codexTurnSurvival === true,
    );
  return (
    <>
      <KeepAwakeSetting />
      <SettingsRow
        {...setting("continue-threads-after-server-update")}
        serverScoped
        settingKeys={["continueThreadsAfterServerUpdate"]}
        description={gt(
          "Automatically resume interrupted threads after an update, crash, or machine restart on the selected environments.",
        )}
        status={
          !supportsRestartContinuation
            ? gt("All selected connected environments must support restart continuation.")
            : undefined
        }
        resetAction={
          supportsRestartContinuation &&
          settings.continueThreadsAfterServerUpdate !==
            DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate ? (
            <SettingResetButton
              label={gt("continue threads after restarts")}
              onClick={() =>
                updateSettings({
                  continueThreadsAfterServerUpdate:
                    DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate,
                })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["continueThreadsAfterServerUpdate"]}
            checked={settings.continueThreadsAfterServerUpdate}
            disabled={!supportsRestartContinuation}
            onCheckedChange={(checked) =>
              updateSettings({ continueThreadsAfterServerUpdate: Boolean(checked) })
            }
            aria-label={gt("Continue threads after restarts")}
          />
        }
      />

      <SettingsRow
        {...setting("codex-turn-survival")}
        serverScoped
        settingKeys={["codexTurnsSurviveServerStop"]}
        description={gt("Keep a running Codex turn alive when GOAT stops on macOS or Linux.")}
        status={
          !supportsCodexSurvival
            ? gt("All selected environments must support Codex turn survival.")
            : undefined
        }
        resetAction={
          supportsCodexSurvival &&
          settings.codexTurnsSurviveServerStop !==
            DEFAULT_UNIFIED_SETTINGS.codexTurnsSurviveServerStop ? (
            <SettingResetButton
              label={gt("keep Codex turns running")}
              onClick={() =>
                updateSettings({
                  codexTurnsSurviveServerStop: DEFAULT_UNIFIED_SETTINGS.codexTurnsSurviveServerStop,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={mixedCodexSurvival ? null : settings.codexTurnsSurviveServerStop}
            disabled={!supportsCodexSurvival}
            onValueChange={(value) => {
              if (value === "off" || value === "restart" || value === "always")
                updateSettings({ codexTurnsSurviveServerStop: value });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-64"
              aria-label={gt("Keep Codex turns running")}
            >
              <SelectValue>
                {(value: "off" | "restart" | "always" | null) =>
                  value === null
                    ? gt("Mixed")
                    : value === "off"
                      ? gt("Off")
                      : value === "restart"
                        ? gt("Restarts and updates (default)")
                        : gt("Also after quitting the app")
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="off">
                {gt("Off")}
              </SelectItem>
              <SelectItem hideIndicator value="restart">
                {gt("Restarts and updates (default)")}
              </SelectItem>
              <SelectItem hideIndicator value="always">
                {gt("Also after quitting the app")}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />

      <CodexAppServerIsolationSetting />
    </>
  );
}
