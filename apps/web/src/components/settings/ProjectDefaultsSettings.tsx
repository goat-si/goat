import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import { useGT, useMessages } from "gt-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type ProviderInstanceId,
  type WorktreeSubmodules,
} from "@goat/contracts";
import { createModelSelection, pickModelSelection } from "@goat/shared/model";
import { resolveProjectSettings } from "@goat/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";

import { mergeEnvironmentSettings, useClientSettings } from "../../hooks/useSettings";
import {
  defaultModelSelectionsAreMixed,
  getCustomModelOptionsByInstance,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";

import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { resolveEnvModeLabel, WORKTREE_SUBMODULES_LABELS } from "../BranchToolbar.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";

import { TraitsPicker } from "../chat/TraitsPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Switch } from "../ui/switch";
import { resolveDefaultModelSettingsPresentation } from "./ProjectDefaultsSettings.logic";
import type { ProjectSettingsCategory } from "./ProjectSettingsPanel";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { StandingInstructionsSettings } from "./StandingInstructionsSettings";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingSource,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const WORKTREE_SUBMODULES_OPTIONS = ["recursive", "top-level", "none"] as const;
function isWorktreeSubmodules(value: string | null): value is WorktreeSubmodules {
  return value !== null && (WORKTREE_SUBMODULES_OPTIONS as readonly string[]).includes(value);
}

export function ProjectDefaultsSettings({ category }: { category: ProjectSettingsCategory }) {
  const localizedSetting = useTranslatedSearchableSetting();
  const gt = useGT();
  const mergeMethodLabels = {
    merge: gt("Merge"),
    squash: gt("Squash and merge"),
    rebase: gt("Rebase and merge"),
  };
  const m = useMessages();
  const { scope, target, targets, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const clientSettings = useClientSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers =
    (representative?.serverConfig
      ? providersByEnvironment.get(representative.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      target?.projectId ?? null,
    ),
  );
  const presentation = resolveDefaultModelSettingsPresentation(
    {
      entries,
      providers,
      settings,
      projectId: target?.projectId ?? null,
    },
    gt,
  );
  const selection = presentation.selection;

  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  const mixedModel = defaultModelSelectionsAreMixed(
    clientSettings,
    targets.map((candidate) => ({
      projectId: candidate.projectId,
      settings: candidate.settings,
      providers: providersByEnvironment.get(candidate.environmentId) ?? EMPTY_SERVER_PROVIDERS,
    })),
  );
  const automaticModel =
    targets.length > 0 &&
    targets.every((candidate) => candidate.settings.defaultModelSelection === null);
  const mixedPermissions = useScopedSettingsMixed(["defaultRuntimeMode"]);
  const PermissionIcon = runtimeModeConfig[settings.defaultRuntimeMode].icon;
  const mixedWorkspace = useScopedSettingsMixed(["defaultThreadEnvMode"]);
  const mixedSubmodules = useScopedSettingsMixed(["worktreeSubmodules"]);
  const mixedAutoPull = useScopedSettingsMixed(["defaultAutoPull"]);
  const mixedAgentCredits = useScopedSettingsMixed(["removeAgentCreditsOnMerge"]);
  const mixedMergeMethod = useScopedSettingsMixed(["pullRequestMergeMethod"]);
  const modelSource = useScopedSettingSource(["defaultModelSelection"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unavailable = connectedEnvironments.length === 0;
  const effective = target
    ? resolveProjectSettings(target.settings, null, null, null).settings
    : null;

  function modelDisabledReason(instanceId: ProviderInstanceId, model: string): string | null {
    const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
    for (const candidate of targets) {
      const environment = environments.find(
        (entry) => entry.environmentId === candidate.environmentId,
      );
      const providers = providersByEnvironment.get(candidate.environmentId);
      if (!environment?.serverConfig || !providers) continue;
      const entry = applyProviderInstanceSettings(
        deriveProviderInstanceEntries(providers),
        candidate.settings,
        candidate.projectId,
      ).find((option) => option.instanceId === instanceId);
      const options = getCustomModelOptionsByInstance(
        mergeEnvironmentSettings(candidate.settings, settings),
        providers,
      ).get(instanceId);
      if (
        !entry?.enabled ||
        !entry.isAvailable ||
        entry.driverKind !== sourceEntry?.driverKind ||
        !options?.some((option) => option.slug === model && !option.isUnavailable)
      ) {
        return gt(
          "This model is unavailable on {environment}. Select that environment to choose its model separately.",
          { environment: environment.label },
        );
      }
    }
    return null;
  }

  const effortDisabledReason = selection
    ? modelDisabledReason(selection.instanceId, selection.model)
    : null;

  const setModel = (value: ModelSelection | null) => {
    const reason = value ? modelDisabledReason(value.instanceId, value.model) : null;
    if (reason) {
      toastManager.add({
        type: "error",
        title: gt("Default model not saved"),
        description: reason,
      });
      return;
    }
    updateSettings({ defaultModelSelection: value });
  };

  const modelRow = (
    <SettingsRow
      serverScoped
      settingKeys={["defaultModelSelection"]}
      mixed={mixedModel}
      id="default-model"
      title={gt("Model")}
      description={
        isProjectScope
          ? gt("Model for new threads in this project.")
          : !unavailable && modelSource !== "project" && automaticModel
            ? gt("Default model for new threads, selected automatically. Projects can override it.")
            : gt("Default model for new threads. Projects can override it.")
      }
      status={
        mixedModel
          ? automaticModel
            ? gt(
                "Automatic defaults differ. Select one environment or choose a shared model to edit effort.",
              )
            : gt("Defaults differ. Select one environment or choose a shared model to edit effort.")
          : (presentation.providerNote ?? effortDisabledReason)
      }
      resetAction={
        settings.defaultModelSelection !== null ? (
          <SettingResetButton label={gt("default model")} onClick={() => setModel(null)} />
        ) : null
      }
      control={
        selection ? (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              environmentId={representative?.environmentId ?? null}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptions}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              {...(mixedModel
                ? { triggerLabel: automaticModel ? gt("Automatic (mixed)") : gt("Mixed") }
                : {})}
              getModelDisabledReason={modelDisabledReason}
              onOpenProviderSetup={(instanceId) => {
                if (representative)
                  void navigate({
                    to: "/settings/providers",
                    search: { environmentId: representative.environmentId, instanceId },
                  });
              }}
              onInstanceModelChange={(instanceId, model) =>
                setModel(
                  pickModelSelection(
                    mixedModel ? null : settings.defaultModelSelection,
                    instanceId,
                    model,
                    mixedModel ? null : selection,
                  ),
                )
              }
            />
            {!mixedModel && !presentation.providerNote && !effortDisabledReason && activeEntry ? (
              <TraitsPicker
                provider={activeEntry.driverKind}
                models={activeEntry.models}
                model={selection.model}
                modelOptions={selection.options ?? []}
                allowPromptInjectedEffort={false}
                planModeEnabled={settings.planModeEnabled}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onModelOptionsChange={(options) =>
                  setModel(createModelSelection(selection.instanceId, selection.model, options))
                }
              />
            ) : null}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">
            {mixedModel ? gt("Mixed") : gt("No providers available")}
          </span>
        )
      }
    />
  );
  const workspaceRow = (
    <SettingsRow
      serverScoped
      settingKeys={["defaultThreadEnvMode"]}
      mixed={mixedWorkspace}
      id={searchableSetting("new-threads").id}
      title={gt("Workspace")}
      description={
        isProjectScope
          ? gt("Where new threads in this project start.")
          : gt("Where new threads start. Projects and their goat.json can override it.")
      }
      resetAction={
        !isProjectScope && settings.defaultThreadEnvMode !== null ? (
          <SettingResetButton
            label={gt("default workspace")}
            onClick={() => updateSettings({ defaultThreadEnvMode: null })}
          />
        ) : null
      }
      control={
        <Select
          value={mixedWorkspace ? null : (effective?.defaultThreadEnvMode ?? null)}
          onValueChange={(value) => {
            if (value === "local" || value === "worktree")
              updateSettings({ defaultThreadEnvMode: value });
          }}
        >
          <SelectTrigger size="sm" aria-label={gt("Default workspace")}>
            <SelectValue>
              {(value: string | null) =>
                value === "local" || value === "worktree"
                  ? m(resolveEnvModeLabel(value))
                  : unavailable
                    ? gt("Unavailable")
                    : gt("Mixed")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="local">{m(resolveEnvModeLabel("local"))}</SelectItem>
            <SelectItem value="worktree">{m(resolveEnvModeLabel("worktree"))}</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );

  return (
    <SettingsSection
      id={category === "source-control" ? "source-control-defaults" : "project-defaults"}
      title={category === "source-control" ? gt("Repositories") : gt("New threads")}
    >
      {category === "project" ? (
        <>
          {modelRow}
          {workspaceRow}
          <StandingInstructionsSettings isProjectScope={isProjectScope} />
        </>
      ) : category === "general" ? (
        <>
          {modelRow}
          <SettingsRow
            serverScoped
            settingKeys={["defaultRuntimeMode"]}
            mixed={mixedPermissions}
            id={searchableSetting("default-permissions").id}
            title={m(searchableSetting("default-permissions").title)}
            description={
              isProjectScope
                ? gt("Permissions for new threads in this project.")
                : gt("Default permissions for new threads. Projects can override them.")
            }
            resetAction={
              settings.defaultRuntimeMode !== DEFAULT_SERVER_SETTINGS.defaultRuntimeMode ? (
                <SettingResetButton
                  label={gt("default permissions")}
                  onClick={() =>
                    updateSettings({
                      defaultRuntimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={mixedPermissions ? null : settings.defaultRuntimeMode}
                onValueChange={(value) => {
                  if (value) updateSettings({ defaultRuntimeMode: value });
                }}
              >
                <SelectTrigger size="sm" aria-label={gt("Default permissions")}>
                  {!mixedPermissions && (
                    <PermissionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <SelectValue>
                    {mixedPermissions
                      ? gt("Mixed")
                      : m(runtimeModeConfig[settings.defaultRuntimeMode].label)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {runtimeModeOptions.map((mode) => {
                    const option = runtimeModeConfig[mode];
                    const Icon = option.icon;
                    return (
                      <SelectItem key={mode} value={mode} className="min-w-64">
                        <div className="grid gap-0.5">
                          <span className="inline-flex items-center gap-1.5 font-medium">
                            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                            {m(option.label)}
                          </span>
                          <span className="text-xs leading-4 text-muted-foreground">
                            {m(option.description)}
                          </span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
            }
          />
          {workspaceRow}
          <SettingsRow
            serverScoped
            settingKeys={["worktreeSubmodules"]}
            mixed={mixedSubmodules}
            id={searchableSetting("worktree-submodules").id}
            title={m(searchableSetting("worktree-submodules").title)}
            description={
              isProjectScope
                ? gt("How new worktrees in this project populate git submodules.")
                : gt(
                    "How new worktrees populate git submodules. Projects and their goat.json can override it.",
                  )
            }
            resetAction={
              !isProjectScope && settings.worktreeSubmodules !== null ? (
                <SettingResetButton
                  label={gt("worktree submodules")}
                  onClick={() => updateSettings({ worktreeSubmodules: null })}
                />
              ) : null
            }
            control={
              <Select
                value={mixedSubmodules ? null : (effective?.worktreeSubmodules ?? null)}
                onValueChange={(value) => {
                  if (isWorktreeSubmodules(value)) updateSettings({ worktreeSubmodules: value });
                }}
              >
                <SelectTrigger size="sm" aria-label={gt("Worktree submodules")}>
                  <SelectValue>
                    {(value: string | null) =>
                      isWorktreeSubmodules(value)
                        ? m(WORKTREE_SUBMODULES_LABELS[value])
                        : unavailable
                          ? gt("Unavailable")
                          : gt("Mixed")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {WORKTREE_SUBMODULES_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {m(WORKTREE_SUBMODULES_LABELS[option])}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <StandingInstructionsSettings isProjectScope={isProjectScope} />
        </>
      ) : (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["defaultAutoPull"]}
            mixed={mixedAutoPull}
            id="automatic-pull"
            title={gt("Automatically pull")}
            description={
              isProjectScope
                ? gt(
                    "Keeps this project's default branch current when the checkout has no local changes or commits.",
                  )
                : gt(
                    "Keeps the default branch current when the checkout has no local changes or commits. Projects can override it.",
                  )
            }
            resetAction={
              settings.defaultAutoPull ? (
                <SettingResetButton
                  label={gt("default automatic pull")}
                  tooltip={gt("Reset automatic pull to off")}
                  onClick={() => updateSettings({ defaultAutoPull: false })}
                />
              ) : null
            }
            control={
              <Switch
                aria-label={gt("Default automatic pull")}
                mixed={mixedAutoPull}
                checked={mixedAutoPull ? false : settings.defaultAutoPull}
                onCheckedChange={(enabled) => updateSettings({ defaultAutoPull: enabled })}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["removeAgentCreditsOnMerge"]}
            mixed={mixedAgentCredits}
            {...localizedSetting("remove-agent-credits-on-merge")}
            description={gt(
              "Remove recognized agent credit lines from merge and squash messages on hosts that support it, keeping human co-authors. Includes auto-merge. Excludes merge queues, stack merges, and existing commits.",
            )}
            resetAction={
              settings.removeAgentCreditsOnMerge ? (
                <SettingResetButton
                  label={gt("agent credit removal")}
                  tooltip={gt("Keep agent credits")}
                  onClick={() => updateSettings({ removeAgentCreditsOnMerge: false })}
                />
              ) : null
            }
            control={
              <Switch
                aria-label={gt("Remove agent credits when merging")}
                mixed={mixedAgentCredits}
                checked={mixedAgentCredits ? false : settings.removeAgentCreditsOnMerge}
                onCheckedChange={(enabled) =>
                  updateSettings({ removeAgentCreditsOnMerge: enabled })
                }
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["pullRequestMergeMethod"]}
            mixed={mixedMergeMethod}
            {...localizedSetting("pull-request-merge-method")}
            description={
              isProjectScope
                ? gt("Pull requests in this project start with this method.")
                : gt(
                    "Pull requests start with this method. Last selected reuses whatever you chose most recently on this device.",
                  )
            }
            resetAction={
              settings.pullRequestMergeMethod !== null ? (
                <SettingResetButton
                  label={gt("default merge method")}
                  tooltip={gt("Reset to last selected")}
                  onClick={() => updateSettings({ pullRequestMergeMethod: null })}
                />
              ) : null
            }
            control={
              <Select
                value={mixedMergeMethod ? null : (settings.pullRequestMergeMethod ?? "last")}
                onValueChange={(value) => {
                  if (value === "last") updateSettings({ pullRequestMergeMethod: null });
                  else if (value === "merge" || value === "squash" || value === "rebase")
                    updateSettings({ pullRequestMergeMethod: value });
                }}
              >
                <SelectTrigger size="sm" aria-label={gt("Default pull request merge method")}>
                  <SelectValue>
                    {(value: string | null) =>
                      value === "merge" || value === "squash" || value === "rebase"
                        ? mergeMethodLabels[value]
                        : value === "last"
                          ? "Last selected"
                          : "Mixed"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="last">{gt("Last selected")}</SelectItem>
                  <SelectItem value="merge">{mergeMethodLabels.merge}</SelectItem>
                  <SelectItem value="squash">{mergeMethodLabels.squash}</SelectItem>
                  <SelectItem value="rebase">{mergeMethodLabels.rebase}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </>
      )}
    </SettingsSection>
  );
}
