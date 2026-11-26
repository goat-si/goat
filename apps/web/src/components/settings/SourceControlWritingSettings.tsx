import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import { msg, useGT, useMessages } from "gt-react";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type {
  ProviderInstanceId,
  ServerSettings,
  SourceControlWritingStyleMode,
} from "@goat/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@goat/contracts/settings";
import { createModelSelection, pickModelSelection } from "@goat/shared/model";
import {
  isTextGenerationEligible,
  resolveReviewGuideModelSelection,
  resolveSourceControlWriterModelSelection,
} from "@goat/shared/serverSettings";

import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  getTextGenerationModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { BranchNamingSettings } from "./BranchNamingSettings";

const MODE_OPTIONS: Record<SourceControlWritingStyleMode, { label: string; description: string }> =
  {
    repo_conventions: {
      label: msg("Repository conventions"),
      description: msg(
        "Commit messages and pull request titles and descriptions match each project's history.",
      ),
    },
    conventional_commits: {
      label: msg("Conventional Commits"),
      description: msg(
        "Conventional Commit prefixes, with short pull request titles and descriptions.",
      ),
    },
    custom: {
      label: msg("Custom instructions"),
      description: msg(
        "Your instructions shape commit messages and pull request titles and descriptions.",
      ),
    },
  };

export function SourceControlWritingSettingsSection() {
  const m = useMessages();
  const gt = useGT();
  const localizedSetting = useTranslatedSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedReviewGuidesEnabled = useScopedSettingsMixed(["reviewGuidesEnabled"]);
  const navigate = useNavigate();
  const { environment, connectedEnvironments, targets, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const styleFieldMixed = (field: keyof ServerSettings["sourceControlWritingStyle"]) => {
    const first = targets[0];
    return (
      first !== undefined &&
      targets.some(
        (candidate) =>
          candidate.settings.sourceControlWritingStyle[field] !==
          first.settings.sourceControlWritingStyle[field],
      )
    );
  };
  const modeMixed = styleFieldMixed("mode");
  const instructionsMixed = styleFieldMixed("customInstructions");
  const templatesMixed = styleFieldMixed("followChangeRequestTemplates");
  const writingStyleMixed = modeMixed || instructionsMixed;
  const mixedWriterModel = useScopedSettingsMixed(["sourceControlWriterModelSelection"]);
  const mixedReviewGuideModel = useScopedSettingsMixed(["reviewGuideModelSelection"]);
  const mixedReviewGuideInstructions = useScopedSettingsMixed(["reviewGuideInstructions"]);
  const reviewGuideInstructionsEdited = useRef(false);
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const customInstructionsRef = useRef<HTMLTextAreaElement>(null);
  const [editingAllInstructions, setEditingAllInstructions] = useState(false);
  const [allInstructions, setAllInstructions] = useState<string | null>(null);
  const style = settings.sourceControlWritingStyle;
  const defaults = DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle;
  const isSourceControlWritingStyleDirty =
    writingStyleMixed ||
    style.mode !== defaults.mode ||
    style.customInstructions !== defaults.customInstructions;

  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const projectId = target?.projectId ?? null;
  const now = Date.parse(`${useNowMinute()}Z`);
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(textGenerationProviders),
      settings,
      target?.projectId ?? null,
    ),
  );
  const projectEnabledInstanceIds = new Set(
    instanceEntries
      .filter((entry) => entry.enabled && entry.isAvailable)
      .map((entry) => entry.instanceId),
  );
  const projectEffectiveTextGenerationProviders = textGenerationProviders.filter((provider) =>
    projectEnabledInstanceIds.has(provider.instanceId),
  );
  const defaultModelSelection = resolveAppModelSelectionState(
    settings,
    projectEffectiveTextGenerationProviders,
    projectId,
    now,
  );
  const usesDedicatedModel = settings.sourceControlWriterModelSelection !== null;
  const activeSelection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolveSourceControlWriterModelSelection(
        settings,
        projectEffectiveTextGenerationProviders,
        target?.projectId ?? null,
      ),
    },
    projectEffectiveTextGenerationProviders,
    projectId,
    now,
  );
  const canEnableDedicatedModel =
    (usesDedicatedModel ? activeSelection : defaultModelSelection) !== NO_PROVIDER_MODEL_SELECTION;
  const modelOptionsByInstance = getTextGenerationModelOptionsByInstance(
    settings,
    projectEffectiveTextGenerationProviders,
    activeSelection.instanceId,
    activeSelection.model,
  );
  const writerModelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries, true);
  const writerInstanceEntry = instanceEntries.find(
    (entry) => entry.instanceId === activeSelection.instanceId,
  );
  const usesReviewGuideModel = settings.reviewGuideModelSelection !== null;
  const reviewGuideSelection = resolveReviewGuideModelSelection(
    settings,
    textGenerationProviders,
    projectId,
    now,
  );
  const reviewGuidePickerSelection = reviewGuideSelection ?? NO_PROVIDER_MODEL_SELECTION;
  const reviewGuideEntries = instanceEntries;
  const reviewGuideModelOptionsByInstance = getTextGenerationModelOptionsByInstance(
    settings,
    textGenerationProviders,
    reviewGuidePickerSelection.instanceId,
    reviewGuidePickerSelection.model,
  );
  const reviewGuideInstanceEntry = reviewGuideEntries.find(
    (entry) => entry.instanceId === reviewGuideSelection?.instanceId,
  );
  const scopedGuideDisabledReason = useScopedModelDisabledReason(
    settings,
    reviewGuideEntries,
    true,
    now,
  );
  const reviewGuideDisabledReason: typeof scopedGuideDisabledReason = (
    instanceId,
    model,
    options,
  ) =>
    isTextGenerationEligible(
      settings,
      { instanceId, model },
      textGenerationProviders.find((provider) => provider.instanceId === instanceId),
      { projectId, now, purpose: "reviewGuide" },
    )
      ? scopedGuideDisabledReason(instanceId, model, options)
      : "This model is unavailable for review guides.";

  return (
    <SettingsSection id="source-control-text-generation" title={gt("Text generation")}>
      <BranchNamingSettings />
      <SettingsRow
        serverScoped
        settingKeys={["sourceControlWritingStyle"]}
        mixed={writingStyleMixed}
        {...localizedSetting("source-control-writing-style")}
        description={m(MODE_OPTIONS[style.mode].description)}
        resetAction={
          isSourceControlWritingStyleDirty ? (
            <SettingResetButton
              label={gt("commit and pull request writing")}
              onClick={() =>
                updateSettings({
                  sourceControlWritingStyle: {
                    mode: defaults.mode,
                    customInstructions: defaults.customInstructions,
                  },
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={modeMixed ? null : style.mode}
            onValueChange={(value) => {
              const customInstructions = customInstructionsRef.current?.value.trim();
              updateSettings({
                sourceControlWritingStyle: {
                  mode: value as SourceControlWritingStyleMode,
                  ...(customInstructions !== undefined ? { customInstructions } : {}),
                },
              });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-56"
              aria-label={gt("Commit and pull request writing")}
            >
              <SelectValue>
                {(value: SourceControlWritingStyleMode | null) =>
                  value === null ? "Mixed" : m(MODE_OPTIONS[value].label)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(MODE_OPTIONS) as SourceControlWritingStyleMode[]).map((mode) => (
                <SelectItem key={mode} hideIndicator value={mode}>
                  {m(MODE_OPTIONS[mode].label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      >
        {writingStyleMixed ? (
          <div className="mt-3 max-w-2xl space-y-2 pb-3.5">
            {editingAllInstructions ? (
              <>
                <Textarea
                  value={allInstructions ?? ""}
                  onChange={(event) => setAllInstructions(event.target.value)}
                  rows={4}
                  aria-label={gt(
                    "Custom commit and pull request instructions for all selected environments",
                  )}
                  placeholder={gt("Write the instructions each selected environment should use.")}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={allInstructions === null}
                  onClick={() => {
                    if (allInstructions === null) return;
                    updateSettings({
                      sourceControlWritingStyle: {
                        mode: "custom",
                        customInstructions: allInstructions.trim(),
                      },
                    });
                    setEditingAllInstructions(false);
                  }}
                >
                  {gt("Apply instructions to all")}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setAllInstructions(null);
                  setEditingAllInstructions(true);
                }}
              >
                {gt("Write custom instructions for all")}
              </Button>
            )}
          </div>
        ) : style.mode === "custom" ? (
          <div className="mt-3 max-w-2xl pb-3.5">
            <Textarea
              key={style.customInstructions}
              ref={customInstructionsRef}
              defaultValue={style.customInstructions}
              onBlur={(event) => {
                const customInstructions = event.target.value.trim();
                if (customInstructions !== style.customInstructions) {
                  updateSettings({ sourceControlWritingStyle: { customInstructions } });
                }
              }}
              rows={4}
              placeholder={gt(
                "Keep commit subjects under 60 characters. Keep pull request descriptions short and plain.",
              )}
              aria-label={gt("Custom commit and pull request instructions")}
            />
          </div>
        ) : null}
      </SettingsRow>

      <SettingsRow
        serverScoped
        settingKeys={["sourceControlWritingStyle"]}
        mixed={templatesMixed}
        {...localizedSetting("follow-change-request-templates")}
        description={gt("Use the repository's pull request template when it has one.")}
        resetAction={
          templatesMixed ||
          style.followChangeRequestTemplates !== defaults.followChangeRequestTemplates ? (
            <SettingResetButton
              label={gt("pull request templates")}
              onClick={() =>
                updateSettings({
                  sourceControlWritingStyle: {
                    followChangeRequestTemplates: defaults.followChangeRequestTemplates,
                  },
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            mixed={templatesMixed}
            checked={templatesMixed ? false : style.followChangeRequestTemplates}
            onCheckedChange={(checked) =>
              updateSettings({
                sourceControlWritingStyle: {
                  followChangeRequestTemplates: Boolean(checked),
                },
              })
            }
            aria-label={gt("Follow pull request templates")}
          />
        }
      />

      <SettingsRow
        serverScoped
        settingKeys={["sourceControlWriterModelSelection"]}
        {...localizedSetting("source-control-writer-model")}
        description={gt(
          "Model for commit messages, pull request text, and branch or bookmark names. When disabled, use the text generation model configured for this environment.",
        )}
        control={
          !hasServerTargets ? (
            <span className="text-sm text-muted-foreground">
              {gt("Connect an environment to choose its source control writer model.")}
            </span>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {usesDedicatedModel && !canEnableDedicatedModel ? (
                <span className="text-sm text-muted-foreground">
                  {gt("No text generation providers available.")}
                </span>
              ) : null}
              {usesDedicatedModel && canEnableDedicatedModel ? (
                <ProviderModelPicker
                  environmentId={environmentId}
                  activeInstanceId={activeSelection.instanceId}
                  model={activeSelection.model}
                  preserveSelectedModel
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  triggerAriaLabel={gt("Source control writer model")}
                  {...(mixedWriterModel ? { triggerLabel: gt("Mixed") } : {})}
                  {...(environmentId
                    ? {
                        onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                          void navigate({
                            to: "/settings/providers",
                            search: { environmentId, instanceId },
                          });
                        },
                      }
                    : {})}
                  getModelDisabledReason={writerModelDisabledReason}
                  onInstanceModelChange={(instanceId, model) => {
                    const reason = writerModelDisabledReason(instanceId, model);
                    if (reason) {
                      toastManager.add({
                        type: "error",
                        title: gt("Source control writer model not saved"),
                        description: reason,
                      });
                      return;
                    }
                    updateSettings({
                      sourceControlWriterModelSelection: pickModelSelection(
                        mixedWriterModel ? null : settings.sourceControlWriterModelSelection,
                        instanceId,
                        model,
                        mixedWriterModel ? null : activeSelection,
                      ),
                    });
                  }}
                />
              ) : null}
              {usesDedicatedModel &&
              canEnableDedicatedModel &&
              !mixedWriterModel &&
              writerInstanceEntry ? (
                <TraitsPicker
                  provider={writerInstanceEntry.driverKind}
                  models={writerInstanceEntry.models}
                  model={activeSelection.model}
                  modelOptions={activeSelection.options ?? []}
                  allowPromptInjectedEffort={false}
                  planModeEnabled={
                    settings.planModeEnabled || selectsPlanAgent(activeSelection.options)
                  }
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onModelOptionsChange={(options) =>
                    updateSettings({
                      sourceControlWriterModelSelection: createModelSelection(
                        activeSelection.instanceId,
                        activeSelection.model,
                        options,
                      ),
                    })
                  }
                />
              ) : null}
              <Switch
                checked={usesDedicatedModel}
                disabled={!usesDedicatedModel && !canEnableDedicatedModel}
                onCheckedChange={(checked) => {
                  if (checked) {
                    const reason = writerModelDisabledReason(
                      defaultModelSelection.instanceId,
                      defaultModelSelection.model,
                      { includeHidden: true },
                    );
                    if (reason) {
                      toastManager.add({
                        type: "error",
                        title: gt("Writer model not saved"),
                        description: reason,
                      });
                      return;
                    }
                  }
                  updateSettings({
                    sourceControlWriterModelSelection: checked
                      ? createModelSelection(
                          defaultModelSelection.instanceId,
                          defaultModelSelection.model,
                          defaultModelSelection.options,
                        )
                      : null,
                  });
                }}
                aria-label={gt("Use a separate source control writer model")}
              />
            </div>
          )
        }
      />

      <SettingsRow
        serverScoped
        settingKeys={["reviewGuidesEnabled"]}
        mixed={mixedReviewGuidesEnabled}
        {...localizedSetting("review-guides")}
        description={gt(
          "Add a Guide tab to pull requests. An agent explains the changes and points out decisions that need review.",
        )}
        control={
          <Switch
            mixed={mixedReviewGuidesEnabled}
            checked={mixedReviewGuidesEnabled ? false : settings.reviewGuidesEnabled}
            onCheckedChange={(checked) => updateSettings({ reviewGuidesEnabled: Boolean(checked) })}
            aria-label={gt("Review guides")}
          />
        }
      />

      {settings.reviewGuidesEnabled || mixedReviewGuidesEnabled ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["reviewGuideModelSelection"]}
            {...localizedSetting("review-guide-model")}
            description={gt(
              "Model that reads a pull request to write its review guide. It reads the change itself over many steps, so a stronger model helps. Off uses the source control writer model.",
            )}
            control={
              !hasServerTargets ? (
                <span className="text-sm text-muted-foreground">
                  {gt("Connect an environment to choose its review guide model.")}
                </span>
              ) : (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {reviewGuideSelection === null &&
                  (reviewGuideEntries.length === 0 ||
                    !(usesReviewGuideModel || mixedReviewGuideModel)) ? (
                    <span className="text-sm text-muted-foreground">
                      {gt("No review guide models available.")}
                    </span>
                  ) : null}
                  {(usesReviewGuideModel || mixedReviewGuideModel) &&
                  reviewGuideEntries.length > 0 ? (
                    <ProviderModelPicker
                      environmentId={environmentId}
                      activeInstanceId={reviewGuidePickerSelection.instanceId}
                      model={reviewGuidePickerSelection.model}
                      preserveSelectedModel
                      lockedProvider={null}
                      instanceEntries={reviewGuideEntries}
                      modelOptionsByInstance={reviewGuideModelOptionsByInstance}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      triggerAriaLabel={gt("Review guide model")}
                      {...(reviewGuideSelection === null
                        ? { triggerLabel: gt("Unavailable") }
                        : mixedReviewGuideModel
                          ? { triggerLabel: gt("Mixed") }
                          : {})}
                      getModelDisabledReason={reviewGuideDisabledReason}
                      onInstanceModelChange={(instanceId, model) => {
                        const reason = reviewGuideDisabledReason(instanceId, model);
                        if (reason) {
                          toastManager.add({
                            type: "error",
                            title: gt("Review guide model not saved"),
                            description: reason,
                          });
                          return;
                        }
                        updateSettings({
                          reviewGuideModelSelection: pickModelSelection(
                            mixedReviewGuideModel ? null : settings.reviewGuideModelSelection,
                            instanceId,
                            model,
                            mixedReviewGuideModel ? null : reviewGuideSelection,
                          ),
                        });
                      }}
                    />
                  ) : null}
                  {usesReviewGuideModel &&
                  reviewGuideSelection !== null &&
                  !mixedReviewGuideModel &&
                  reviewGuideInstanceEntry ? (
                    <TraitsPicker
                      provider={reviewGuideInstanceEntry.driverKind}
                      models={reviewGuideInstanceEntry.models}
                      model={reviewGuideSelection.model}
                      modelOptions={reviewGuideSelection.options ?? []}
                      allowPromptInjectedEffort={false}
                      planModeEnabled={
                        settings.planModeEnabled || selectsPlanAgent(reviewGuideSelection.options)
                      }
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onModelOptionsChange={(options) =>
                        updateSettings({
                          reviewGuideModelSelection: createModelSelection(
                            reviewGuideSelection.instanceId,
                            reviewGuideSelection.model,
                            options,
                          ),
                        })
                      }
                    />
                  ) : null}
                  <Switch
                    mixed={mixedReviewGuideModel}
                    checked={mixedReviewGuideModel ? false : usesReviewGuideModel}
                    disabled={!usesReviewGuideModel && reviewGuideSelection === null}
                    onCheckedChange={(checked) => {
                      if (!checked) {
                        updateSettings({ reviewGuideModelSelection: null });
                        return;
                      }
                      if (reviewGuideSelection === null) return;
                      const reason = reviewGuideDisabledReason(
                        reviewGuideSelection.instanceId,
                        reviewGuideSelection.model,
                        { includeHidden: true },
                      );
                      if (reason) {
                        toastManager.add({
                          type: "error",
                          title: gt("Review guide model not saved"),
                          description: reason,
                        });
                        return;
                      }
                      updateSettings({ reviewGuideModelSelection: reviewGuideSelection });
                    }}
                    aria-label={gt("Use a separate review guide model")}
                  />
                </div>
              )
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["reviewGuideInstructions"]}
            {...localizedSetting("review-guide-instructions")}
            description={gt(
              "Your preferences for review guides: what to show first, dwell on, or skip. The guide's format and coverage stay the same.",
            )}
            resetAction={
              mixedReviewGuideInstructions || settings.reviewGuideInstructions !== "" ? (
                <SettingResetButton
                  label={gt("review guide instructions")}
                  onClick={() => updateSettings({ reviewGuideInstructions: "" })}
                />
              ) : null
            }
          >
            <div className="mt-3 max-w-2xl pb-3.5">
              <Textarea
                key={`${scopeKey}:${mixedReviewGuideInstructions}:${settings.reviewGuideInstructions}`}
                aria-label={gt("Review guide instructions")}
                onChange={() => {
                  reviewGuideInstructionsEdited.current = true;
                }}
                rows={4}
                defaultValue={mixedReviewGuideInstructions ? "" : settings.reviewGuideInstructions}
                placeholder={
                  mixedReviewGuideInstructions
                    ? gt("Mixed. Enter instructions to apply to all selected targets.")
                    : gt(
                        "Show service interfaces before implementations. Skip test files unless they change behavior. Keep summaries to two sentences.",
                      )
                }
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (
                    reviewGuideInstructionsEdited.current &&
                    (mixedReviewGuideInstructions || value !== settings.reviewGuideInstructions)
                  )
                    updateSettings({ reviewGuideInstructions: value });
                  reviewGuideInstructionsEdited.current = false;
                }}
              />
            </div>
          </SettingsRow>
        </>
      ) : null}
    </SettingsSection>
  );
}
