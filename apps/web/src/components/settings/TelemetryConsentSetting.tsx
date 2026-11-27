import { useGT } from "gt-react";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function TelemetryConsentSetting() {
  const gt = useGT();
  const setting = useTranslatedSearchableSetting()("usage-data");
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { connectedEnvironments } = useSettingsScope();
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (environment) => environment.serverConfig?.environment.capabilities.telemetryConsent === true,
    );
  const override = connectedEnvironments
    .map((environment) => environment.serverConfig?.observability.telemetryOverride)
    .find((value) => value !== undefined);
  return (
    <SettingsRow
      {...setting}
      serverScoped
      settingKeys={["telemetryConsent"]}
      description={gt(
        "Send GOAT which providers, models and features you use, turn results, durations and token counts, under a random ID for this install. Never prompts, responses, code, file paths or credentials.",
      )}
      status={
        !supported
          ? gt("Update the selected servers to change this setting.")
          : override !== undefined
            ? gt("Set by GOAT_TELEMETRY_ENABLED in a selected server's environment.")
            : undefined
      }
      control={
        <ScopedSwitch
          settingKeys={["telemetryConsent"]}
          checked={
            override === undefined
              ? settings.telemetryConsent === "granted"
              : override === "enabled"
          }
          disabled={!supported || override !== undefined}
          onCheckedChange={(checked) =>
            updateSettings({ telemetryConsent: checked ? "granted" : "declined" })
          }
          aria-label={setting.title}
        />
      }
    />
  );
}
