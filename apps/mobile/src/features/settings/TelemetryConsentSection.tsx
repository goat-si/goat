import type { ServerConfig, ServerSettingsPatch, TelemetryConsent } from "@goat/contracts";

import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

/** Whether the selected servers share usage data with GOAT; they send nothing until someone says yes. */
export function TelemetryConsentSection(props: {
  /** Null when the selected servers disagree. */
  readonly consent: TelemetryConsent | null;
  readonly servers: ReadonlyArray<Pick<ServerConfig, "environment" | "observability">>;
  readonly disabled: boolean;
  readonly projectSelected: boolean;
  readonly write: (patch: ServerSettingsPatch) => void;
}) {
  const supported = props.servers.every(
    (server) => server.environment.capabilities.telemetryConsent === true,
  );
  const override = props.servers
    .map((server) => server.observability.telemetryOverride)
    .find((value) => value !== undefined);
  const subtitle = props.projectSelected
    ? "Environment-wide setting. Select All projects to change it."
    : !supported
      ? "Update the selected servers to change this setting."
      : override !== undefined
        ? "Set by GOAT_TELEMETRY_ENABLED in a selected server's environment."
        : "Send GOAT which providers, models and features you use, turn results, durations and token counts. Never prompts, responses, code or credentials.";
  return (
    <SettingsSection title="Privacy">
      <SettingsSwitchRow
        icon="chart.bar.xaxis"
        label="Share usage data"
        subtitle={subtitle}
        value={
          override !== undefined
            ? override === "enabled"
            : props.consent === null
              ? null
              : props.consent === "granted"
        }
        disabled={props.disabled || !supported || override !== undefined}
        onValueChange={(value) => props.write({ telemetryConsent: value ? "granted" : "declined" })}
      />
    </SettingsSection>
  );
}
