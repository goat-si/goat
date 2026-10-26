import {
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  resolveProjectBuiltInSkillEnabled,
} from "@goat/contracts";
import {
  builtInSkillEnvironmentPatch,
  builtInSkillProjectPatch,
} from "@goat/client-runtime/built-in-skill-settings";
import { AgentToolListing } from "@goat/contracts/agentSurface/listing";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { persistScopedSettingsPatch } from "./scopedSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const TOOL_LISTING_LABELS: Readonly<Record<AgentToolListing, string>> = {
  core: "Core",
  full: "All tools",
};

export function AgentToolsSettings() {
  return (
    <SettingsSection id="agent-tools" title="Agent tools">
      <AgentToolListingSetting />
      <DevelopmentDisciplineSetting />
    </SettingsSection>
  );
}

export function DevelopmentDisciplineSetting() {
  const { scope, connectedEnvironments, targets } = useSettingsScope();
  const canWrite = useScopedSettingsWriteAllowed();
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (environment) =>
        environment.serverConfig?.environment.capabilities.devDisciplineSkill === true,
    );
  const values = targets.map((target) => ({
    enabled: resolveProjectBuiltInSkillEnabled(
      target.settings,
      target.projectId,
      "goat-discipline",
    ),
    override:
      target.projectId === null
        ? undefined
        : target.settings.projectSettingsOverrides[target.projectId]?.builtInSkills?.[
            "goat-discipline"
          ]?.enabled,
  }));
  const reference = values[0];
  const mixed = values.some(
    (value) => value.enabled !== reference?.enabled || value.override !== reference?.override,
  );
  const choice = reference?.override === undefined ? "inherit" : reference.override ? "on" : "off";
  const save = async (enabled: boolean | undefined) => {
    if (!canWrite || pending || !supported || (!projectScope && enabled === undefined)) return;
    const serverWrites = connectedEnvironments.flatMap((environment) => {
      const previous = environment.serverConfig?.settings;
      if (!previous) return [];
      const projectIds = projectScope
        ? scope.members
            .filter((member) => member.environmentId === environment.environmentId)
            .map((member) => member.id)
        : [];
      if (projectScope && projectIds.length === 0) return [];
      return [
        {
          environmentId: environment.environmentId,
          label: environment.label,
          previous,
          patch: projectScope
            ? {
                projectSettingsOverrides: builtInSkillProjectPatch(
                  previous,
                  projectIds,
                  "goat-discipline",
                  enabled,
                ),
              }
            : builtInSkillEnvironmentPatch(
                previous.disabledBuiltInSkills,
                "goat-discipline",
                enabled === true,
              ),
        },
      ];
    });
    setPending(true);
    const result = await persistScopedSettingsPatch(
      { serverWrites, clientPatch: {}, hasClientWrite: false, unavailableReason: null },
      (request) =>
        readEnvironmentScope(request.environmentId, AuthSettingsWriteScope)
          ? persistServer(request)
          : Promise.reject(new Error("This connection lacks permission to change settings.")),
      () => undefined,
    );
    setPending(false);
    if (result.failedEnvironments.length > 0)
      toastManager.add({
        type: "error",
        title:
          result.savedEnvironmentCount > 0
            ? "Setting saved on some environments"
            : "Setting not saved",
        description: result.failedEnvironments
          .map(({ label, message }) => `${label}: ${message}`)
          .join("\n"),
      });
  };
  if (!supported) return null;
  return (
    <SettingsRow
      {...searchableSetting("goat-discipline-skill")}
      mixed={mixed}
      description={
        projectScope
          ? "Built in. Off keeps $goat-discipline out of this project's $ menu and turns. Inherit follows the environment."
          : "Built in. On a turn whose message names $goat-discipline, agents get GOAT's longer guidance for code changes. Off keeps it out of the $ menu and out of turns."
      }
      control={
        projectScope ? (
          <Select
            value={mixed ? null : choice}
            disabled={!canWrite || pending || targets.length === 0}
            onValueChange={(value) => {
              if (value === "inherit" || value === "on" || value === "off")
                void save(value === "inherit" ? undefined : value === "on");
            }}
          >
            <SelectTrigger size="sm" aria-label="Development discipline">
              <SelectValue>
                {mixed
                  ? "Mixed"
                  : choice === "inherit"
                    ? `Inherit (${reference?.enabled ? "On" : "Off"})`
                    : choice === "on"
                      ? "On"
                      : "Off"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="inherit">Inherit</SelectItem>
              <SelectItem value="on">On</SelectItem>
              <SelectItem value="off">Off</SelectItem>
            </SelectPopup>
          </Select>
        ) : (
          <Switch
            aria-label="Development discipline"
            mixed={mixed}
            checked={!mixed && reference?.enabled === true}
            disabled={!canWrite || pending || targets.length === 0}
            onCheckedChange={(enabled) => void save(enabled)}
          />
        )
      }
    />
  );
}

/**
 * Environment-wide: the server reads it when an agent lists tools, and a
 * change reaches running agents through tools/list_changed.
 */
export function AgentToolListingSetting() {
  const settings = useScopedSettings();
  const mixed = useScopedSettingsMixed(["agentToolListing"]);
  const updateSettings = useUpdateScopedSettings();
  // Read from the contract so the control follows whichever default ships.
  const shippedDefault = DEFAULT_SERVER_SETTINGS.agentToolListing;

  return (
    <SettingsRow
      serverScoped
      settingKeys={["agentToolListing"]}
      {...searchableSetting("agent-tool-listing")}
      description="Core shows agents two GOAT tools that look up and run the rest. All tools lists every tool up front, which can make each agent's first prompt much larger."
      resetAction={
        mixed || settings.agentToolListing !== shippedDefault ? (
          <SettingResetButton
            label="GOAT tools agents see"
            onClick={() => updateSettings({ agentToolListing: shippedDefault })}
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : settings.agentToolListing}
          onValueChange={(value) => {
            const next = AgentToolListing.literals.find((literal) => literal === value);
            if (next !== undefined) updateSettings({ agentToolListing: next });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="GOAT tools agents see">
            <SelectValue>
              {mixed ? "Mixed" : TOOL_LISTING_LABELS[settings.agentToolListing]}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {AgentToolListing.literals.map((listing) => (
              <SelectItem hideIndicator key={listing} value={listing}>
                <span className="flex w-full items-center justify-between gap-5">
                  <span>{TOOL_LISTING_LABELS[listing]}</span>
                  {listing === shippedDefault ? (
                    <span className="text-xs text-muted-foreground">Default</span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function AgentBrowserAccessSetting() {
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  return (
    <SettingsRow
      serverScoped
      settingKeys={["enableAgentBrowserAccess"]}
      {...searchableSetting("agent-browser-access")}
      description={
        isProjectScope
          ? "Allow agents in this project to use the shared browser. Applies when the agent session next starts."
          : "Allow agents to use the shared browser. Projects can override it."
      }
      resetAction={
        settings.enableAgentBrowserAccess !== DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess ? (
          <SettingResetButton
            label="default browser access"
            onClick={() =>
              updateSettings({
                enableAgentBrowserAccess: DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["enableAgentBrowserAccess"]}
          aria-label="Agent browser access"
          checked={settings.enableAgentBrowserAccess}
          onCheckedChange={(enabled) => updateSettings({ enableAgentBrowserAccess: enabled })}
        />
      }
    />
  );
}
