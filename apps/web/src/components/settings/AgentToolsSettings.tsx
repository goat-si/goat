import { msg, useGT, useMessages } from "gt-react";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import {
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  environmentDeliversBuiltInSkill,
  resolveProjectBuiltInSkillEnabled,
  type BuiltInSkillName,
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
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import type { SettingsSearchItemId } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { AgentWorkspaceTerminalSettings } from "./AgentWorkspaceTerminalSettings";
import { BlockedBrowserHostsSetting } from "./BlockedBrowserHostsSetting";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
  writeScopedSettings,
} from "./useScopedSettings";

const TOOL_LISTING_LABELS: Readonly<Record<AgentToolListing, string>> = {
  core: msg("Core"),
  full: msg("All tools"),
  core_eval: msg("Core + goat_eval"),
};

export function AgentToolsSettings() {
  const gt = useGT();
  return (
    <SettingsSection id="agent-tools" title={gt("Agent tools")}>
      <AgentToolListingSetting />
      <AgentThemeWritesSetting />
      <AgentWorkspaceTerminalSettings />
      <BuiltInSkillSetting
        name="goat-discipline"
        label={gt("Development discipline")}
        searchId="goat-discipline-skill"
        projectDescription={gt(
          "Built in. Off keeps $goat-discipline out of this project's $ menu and turns. Inherit follows the environment.",
        )}
        environmentDescription={gt(
          "Built in. On a turn whose message names $goat-discipline, agents get GOAT's longer guidance for code changes. Off keeps it out of the $ menu and out of turns.",
        )}
      />
      <BuiltInSkillSetting
        name="goat-docs"
        label={gt("GOAT Docs")}
        searchId="goat-docs-skill"
        projectDescription={gt(
          "Built in. Off keeps $goat-docs out of this project's $ menu and turns. Inherit follows the environment.",
        )}
        environmentDescription={gt(
          "Built in. On a turn whose message names $goat-docs, agents answer questions about GOAT from its user guides and cite them. Off keeps it out of the $ menu and out of turns.",
        )}
      />
    </SettingsSection>
  );
}

function AgentThemeWritesSetting() {
  const gt = useGT();
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const allowed = useScopedSettingsWriteAllowed();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  return (
    <SettingsRow
      title={gt("Agent theme changes")}
      serverScoped
      settingKeys={["enableAgentThemeWrites"]}
      description={gt("Allow agents with settings access to publish environment themes.")}
      control={
        <ScopedSwitch
          settingKeys={["enableAgentThemeWrites"]}
          aria-label={gt("Agent theme changes")}
          checked={settings.enableAgentThemeWrites}
          disabled={!allowed || projectScope}
          onCheckedChange={(checked) => update({ enableAgentThemeWrites: Boolean(checked) })}
        />
      }
    />
  );
}

function BuiltInSkillSetting(props: {
  readonly name: BuiltInSkillName;
  readonly label: string;
  readonly searchId: SettingsSearchItemId;
  readonly projectDescription: string;
  readonly environmentDescription: string;
}) {
  const gt = useGT();
  const localizedSetting = useTranslatedSearchableSetting();
  const { scope, connectedEnvironments, targets } = useSettingsScope();
  const canWrite = useScopedSettingsWriteAllowed();
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((environment) =>
      environmentDeliversBuiltInSkill(
        environment.serverConfig?.environment.capabilities,
        props.name,
      ),
    );
  const values = targets.map((target) => ({
    enabled: resolveProjectBuiltInSkillEnabled(target.settings, target.projectId, props.name),
    override:
      target.projectId === null
        ? undefined
        : target.settings.projectSettingsOverrides[target.projectId]?.builtInSkills?.[props.name]
            ?.enabled,
  }));
  const reference = values[0];
  const mixed = values.some(
    (value) => value.enabled !== reference?.enabled || value.override !== reference?.override,
  );
  const choice = reference?.override === undefined ? "inherit" : reference.override ? "on" : "off";
  const save = async (enabled: boolean | undefined) => {
    if (!canWrite || pending || !supported || (!projectScope && enabled === undefined)) return;
    const plan = (environments: Parameters<typeof writeScopedSettings>[0]) => {
      const serverWrites = environments.flatMap((environment) => {
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
                    props.name,
                    enabled,
                  ),
                }
              : builtInSkillEnvironmentPatch(
                  previous.disabledBuiltInSkills,
                  props.name,
                  enabled === true,
                ),
          },
        ];
      });
      return { serverWrites, clientPatch: {}, hasClientWrite: false, unavailableReason: null };
    };
    setPending(true);
    const result = await writeScopedSettings(
      connectedEnvironments,
      plan,
      (request) =>
        readEnvironmentScope(request.environmentId, AuthSettingsWriteScope)
          ? persistServer(request)
          : Promise.reject(new Error(gt("This connection lacks permission to change settings."))),
      () => undefined,
    );
    setPending(false);
    if (result.failedEnvironments.length > 0)
      toastManager.add({
        type: "error",
        title:
          result.savedEnvironmentCount > 0
            ? gt("Setting saved on some environments")
            : gt("Setting not saved"),
        description: result.failedEnvironments
          .map(({ label, message }) => `${label}: ${message}`)
          .join("\n"),
      });
  };
  if (!supported) return null;
  return (
    <SettingsRow
      {...localizedSetting(props.searchId)}
      mixed={mixed}
      description={projectScope ? props.projectDescription : props.environmentDescription}
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
            <SelectTrigger size="sm" aria-label={props.label}>
              <SelectValue>
                {mixed
                  ? gt("Mixed")
                  : choice === "inherit"
                    ? gt("Inherit ({value})", { value: reference?.enabled ? gt("On") : gt("Off") })
                    : choice === "on"
                      ? gt("On")
                      : gt("Off")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="inherit">{gt("Inherit")}</SelectItem>
              <SelectItem value="on">{gt("On")}</SelectItem>
              <SelectItem value="off">{gt("Off")}</SelectItem>
            </SelectPopup>
          </Select>
        ) : (
          <Switch
            aria-label={props.label}
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
  const gt = useGT();
  const localizedSetting = useTranslatedSearchableSetting();
  const settings = useScopedSettings();
  const m = useMessages();
  const mixed = useScopedSettingsMixed(["agentToolListing"]);
  const updateSettings = useUpdateScopedSettings();
  // Read from the contract so the control follows whichever default ships.
  const shippedDefault = DEFAULT_SERVER_SETTINGS.agentToolListing;

  return (
    <SettingsRow
      serverScoped
      settingKeys={["agentToolListing"]}
      {...localizedSetting("agent-tool-listing")}
      description={gt(
        "Core shows agents two GOAT tools that look up and run the rest. All tools lists every tool up front, which can make each agent's first prompt much larger. Core + goat_eval also lists goat_eval, which runs several GOAT calls as one program; it is opt-in while it is measured.",
      )}
      resetAction={
        mixed || settings.agentToolListing !== shippedDefault ? (
          <SettingResetButton
            label={gt("GOAT tools agents see")}
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
          <SelectTrigger
            size="sm"
            className="w-full sm:w-40"
            aria-label={gt("GOAT tools agents see")}
          >
            <SelectValue>
              {mixed ? gt("Mixed") : m(TOOL_LISTING_LABELS[settings.agentToolListing])}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {AgentToolListing.literals.map((listing) => (
              <SelectItem hideIndicator key={listing} value={listing}>
                <span className="flex w-full items-center justify-between gap-5">
                  <span>{m(TOOL_LISTING_LABELS[listing])}</span>
                  {listing === shippedDefault ? (
                    <span className="text-xs text-muted-foreground">{gt("Default")}</span>
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
  const gt = useGT();
  const setting = useTranslatedSearchableSetting()("agent-browser-access");
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["enableAgentBrowserAccess"]}
        {...setting}
        description={
          isProjectScope
            ? gt(
                "Allow agents in this project to use the shared browser. Applies when the agent session next starts.",
              )
            : gt("Allow agents to use the shared browser. Projects can override it.")
        }
        resetAction={
          settings.enableAgentBrowserAccess !== DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess ? (
            <SettingResetButton
              label={setting.title}
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
            aria-label={setting.title}
            checked={settings.enableAgentBrowserAccess}
            onCheckedChange={(enabled) => updateSettings({ enableAgentBrowserAccess: enabled })}
          />
        }
      />
      <BlockedBrowserHostsSetting />
    </>
  );
}
