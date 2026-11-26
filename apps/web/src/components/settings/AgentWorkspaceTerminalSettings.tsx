import { msg, useGT, useMessages } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import { Atom } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const WORKSPACE_CHOICES = [
  { value: "off", label: msg("Off") },
  { value: "read", label: msg("Read") },
  { value: "read_write", label: msg("Read and write") },
] as const;
const TERMINAL_CHOICES = [
  { value: "off", label: msg("Off") },
  { value: "read", label: msg("Read") },
  { value: "operate", label: msg("Operate") },
] as const;

export function AgentWorkspaceTerminalSettings() {
  return (
    <>
      <AccessSetting setting="agentWorkspaceAccess" choices={WORKSPACE_CHOICES} />
      <AccessSetting setting="agentTerminalAccess" choices={TERMINAL_CHOICES} />
    </>
  );
}

function AccessSetting({
  setting,
  choices,
}: {
  readonly setting: "agentWorkspaceAccess" | "agentTerminalAccess";
  readonly choices: readonly {
    readonly value: "off" | "read" | "read_write" | "operate";
    readonly label: string;
  }[];
}) {
  const gt = useGT();
  const m = useMessages();
  const localizedSetting = useTranslatedSearchableSetting();
  const { connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const mixed = useScopedSettingsMixed([setting]);
  const update = useUpdateScopedSettings();
  const allowed = useAtomValue(
    Atom.make(
      (get) =>
        connectedEnvironments.length > 0 &&
        connectedEnvironments.every(({ environmentId }) =>
          get(
            serverEnvironment.updateSettings.permissionAtom(environmentId, {
              patch: { [setting]: "off" },
            }),
          ),
        ),
    ),
  );
  const workspace = setting === "agentWorkspaceAccess";
  const row = localizedSetting(workspace ? "agent-workspace-access" : "agent-terminal-access");
  const value = settings[setting];
  const selected = choices.find((choice) => choice.value === value);
  return (
    <SettingsRow
      {...row}
      serverScoped
      settingKeys={[setting]}
      description={
        workspace
          ? gt(
              "Allow explicitly authorized agents to read or save workspace files. Projects can override this policy. Off blocks new calls.",
            )
          : gt(
              "Operate permits shell execution with the server's OS file and network authority. The starting workspace directory is not a sandbox. Off blocks new calls but does not stop running terminals; close them in the terminal view.",
            )
      }
      resetAction={
        mixed || value !== DEFAULT_SERVER_SETTINGS[setting] ? (
          <SettingResetButton
            label={row.title}
            disabled={!allowed}
            onClick={() =>
              update(workspace ? { agentWorkspaceAccess: "off" } : { agentTerminalAccess: "off" })
            }
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : value}
          disabled={!allowed}
          onValueChange={(next) => {
            if (workspace && (next === "off" || next === "read" || next === "read_write"))
              update({ agentWorkspaceAccess: next });
            if (!workspace && (next === "off" || next === "read" || next === "operate"))
              update({ agentTerminalAccess: next });
          }}
        >
          <SelectTrigger size="sm" aria-label={row.title}>
            <SelectValue>
              {mixed ? gt("Mixed") : selected ? m(selected.label) : undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {choices.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {m(choice.label)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
