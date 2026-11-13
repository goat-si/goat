import { useAtomValue } from "@effect/atom-react";
import {
  HUB_RELAY_WARNING_MAX_GB,
  type EnvironmentId,
  type OpenCodexHubRelayWarning,
} from "@goat/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Input } from "../ui/input";
import { HubRelayWarning } from "./HubLinkLines";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type ThresholdKey = "hubRelayWarningDeviceGbPerDay" | "hubRelayWarningHubGbPerDay";

function GbInput(props: {
  readonly label: string;
  readonly value: number;
  readonly disabled: boolean;
  readonly onCommit: (value: number) => void;
  readonly onInvalid: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    setDraft(null);
    if (draft === null || draft.trim() === "") return;
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > HUB_RELAY_WARNING_MAX_GB)
      props.onInvalid();
    else if (parsed !== props.value) props.onCommit(parsed);
  };
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Input
        size="sm"
        type="number"
        min={0}
        max={HUB_RELAY_WARNING_MAX_GB}
        step="any"
        className="w-20"
        aria-label={props.label}
        disabled={props.disabled}
        value={draft ?? String(props.value)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      {props.label}
    </label>
  );
}

/**
 * The relay thresholds this environment warns at when it is the OpenCodex Home. They only add a
 * warning; an older GOAT drops them on save, which the row reports.
 */
export function HubRelayWarningRow({
  environmentId,
  warning,
}: {
  readonly environmentId: EnvironmentId;
  readonly warning: OpenCodexHubRelayWarning | null;
}) {
  const device = useEnvironmentSettings(
    environmentId,
    (value) => value.hubRelayWarningDeviceGbPerDay,
  );
  const hub = useEnvironmentSettings(environmentId, (value) => value.hubRelayWarningHubGbPerDay);
  const canConfigure = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (key: ThresholdKey, value: number) => {
    setSaving(true);
    setError(null);
    const result = await update({ environmentId, input: { patch: { [key]: value } } });
    setSaving(false);
    if (result._tag === "Failure") setError("Could not save the threshold. Try again.");
    else if (result.value[key] !== value)
      setError("This machine runs an older GOAT without relay warnings. Update GOAT there first.");
  };
  return (
    <SettingsRow
      {...searchableSetting("hub-relay-warning")}
      serverScoped
      settingKeys={["hubRelayWarningDeviceGbPerDay", "hubRelayWarningHubGbPerDay"]}
      description="Warn in Hub and Fleet when one OpenCodex Child, or all of them together, send this many gigabytes through a Pen relay in 24 hours. 0 turns a warning off. A warning never stops a turn or a link."
      status={
        error ? (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        ) : (
          <HubRelayWarning warning={warning} className="text-warning-foreground" />
        )
      }
      control={
        <span className="flex flex-wrap items-center gap-3">
          <GbInput
            label="GB per device"
            value={device}
            disabled={saving || !canConfigure}
            onCommit={(value) => void save("hubRelayWarningDeviceGbPerDay", value)}
            onInvalid={() =>
              setError(
                `Enter a number from 0 to ${HUB_RELAY_WARNING_MAX_GB.toLocaleString("en-US")} GB.`,
              )
            }
          />
          <GbInput
            label="GB per hub"
            value={hub}
            disabled={saving || !canConfigure}
            onCommit={(value) => void save("hubRelayWarningHubGbPerDay", value)}
            onInvalid={() =>
              setError(
                `Enter a number from 0 to ${HUB_RELAY_WARNING_MAX_GB.toLocaleString("en-US")} GB.`,
              )
            }
          />
        </span>
      }
    />
  );
}
