import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import { Atom } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const WORKSPACE_CHOICES = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read" },
  { value: "read_write", label: "Read and write" },
] as const;
const TERMINAL_CHOICES = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read" },
  { value: "operate", label: "Operate" },
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
  const title = workspace ? "Agent workspace access" : "Agent terminal access";
  const value = settings[setting];
  return (
    <SettingsRow
      {...searchableSetting(workspace ? "agent-workspace-access" : "agent-terminal-access")}
      serverScoped
      settingKeys={[setting]}
      description={
        workspace
          ? "Allow explicitly authorized agents to read or save workspace files. Projects can override this policy. Off blocks new calls."
          : "Operate permits shell execution with the server's OS file and network authority. The starting workspace directory is not a sandbox. Off blocks new calls but does not stop running terminals; close them in the terminal view."
      }
      resetAction={
        mixed || value !== DEFAULT_SERVER_SETTINGS[setting] ? (
          <SettingResetButton
            label={title}
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
          <SelectTrigger size="sm" aria-label={title}>
            <SelectValue>
              {mixed ? "Mixed" : choices.find((choice) => choice.value === value)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {choices.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
