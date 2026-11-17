import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  ProviderInstanceId,
  type ProviderDriverKind,
  type ServerProvider,
} from "@goat/contracts";
import type { UnifiedSettings } from "@goat/contracts/settings";
import { normalizeModelSlug } from "@goat/shared/model";

import type {
  ComposerThreadDraftState,
  ProviderOptionSelectionsByProvider,
} from "./composerDraftStore";
import {
  readInstanceCustomModels,
  resolveAppModelSelection,
  resolveAppModelSelectionForInstance,
} from "./modelSelection";
import { getDefaultServerModel } from "./providerModels";

export interface EffectiveComposerModelState {
  selectedModel: string;
  modelOptions: ProviderOptionSelectionsByProvider | null;
}

function selectionsByInstance(
  modelSelection: ModelSelection | null | undefined,
): Partial<Record<string, ModelSelection>> | null {
  return modelSelection ? { [modelSelection.instanceId]: modelSelection } : null;
}

function modelSelectionByProviderToOptions(
  map: Partial<Record<string, ModelSelection>> | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!map) return null;
  const result: ProviderOptionSelectionsByProvider = {};
  for (const [provider, selection] of Object.entries(map)) {
    if (selection?.options && selection.options.length > 0) {
      result[provider] = selection.options;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function deriveEffectiveComposerModelState(input: {
  draft:
    | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderDriverKind;
  selectedInstanceId?: ProviderInstanceId | null | undefined;
  /** The instance the draft, thread or project asked for; differs from the selection on fallback. */
  requestedInstanceId?: ProviderInstanceId | null | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const baseModelCandidate =
    input.threadModelSelection?.model ?? input.projectModelSelection?.model ?? null;
  const preserveThreadModel =
    input.selectedInstanceId !== null &&
    input.selectedInstanceId !== undefined &&
    input.threadModelSelection?.instanceId === input.selectedInstanceId;
  const baseModel =
    (input.selectedInstanceId
      ? resolveAppModelSelectionForInstance(
          input.selectedInstanceId,
          input.settings,
          input.providers,
          baseModelCandidate,
          { preserveUnavailableSelection: preserveThreadModel },
        )
      : null) ??
    // Antigravity has no static model or cross-account catalog fallback.
    (input.selectedProvider === "antigravity" && input.selectedInstanceId ? "" : null) ??
    resolveAppModelSelection(
      input.selectedProvider,
      input.settings,
      input.providers,
      baseModelCandidate,
    ) ??
    normalizeModelSlug(baseModelCandidate, input.selectedProvider) ??
    getDefaultServerModel(input.providers, input.selectedProvider);
  const instanceSelection = input.selectedInstanceId
    ? input.draft?.modelSelectionByProvider?.[input.selectedInstanceId]
    : undefined;
  // Legacy driver-keyed drafts belong to the default instance.
  const legacySelection =
    input.selectedInstanceId &&
    input.selectedInstanceId !== defaultInstanceIdForDriver(input.selectedProvider)
      ? undefined
      : input.draft?.modelSelectionByProvider?.[ProviderInstanceId.make(input.selectedProvider)];
  const activeSelection = instanceSelection ?? legacySelection;
  const activeSelectionInstanceId = instanceSelection
    ? (input.selectedInstanceId ?? ProviderInstanceId.make(input.selectedProvider))
    : ProviderInstanceId.make(input.selectedProvider);
  const selectedModel = activeSelection?.model
    ? (resolveAppModelSelectionForInstance(
        activeSelectionInstanceId,
        input.settings,
        input.providers,
        activeSelection.model,
        { preserveUnavailableSelection: true },
      ) ??
      (input.selectedProvider === "antigravity" ? "" : null) ??
      resolveAppModelSelection(
        input.selectedProvider,
        input.settings,
        input.providers,
        activeSelection.model,
      ))
    : baseModel;
  // Draft options win; otherwise an existing thread's options, even none, outrank the project's.
  // Selections stay with them, so a fallback instance can check which model the options belong to.
  const optionSelections =
    [
      input.draft?.modelSelectionByProvider,
      selectionsByInstance(input.threadModelSelection ?? input.projectModelSelection),
    ].find((selections) => modelSelectionByProviderToOptions(selections) !== null) ?? null;
  const modelOptions = modelSelectionByProviderToOptions(optionSelections);

  return {
    selectedModel,
    modelOptions: withFallbackInstanceOptions({
      ...input,
      modelOptions,
      optionSelections,
      selectedModel,
    }),
  };
}

/**
 * When the requested instance is disabled or unavailable, the composer shows another instance of
 * the same driver. When that instance has no options of its own and shows the model the requested
 * instance's options were picked with, it takes those options instead of the model's defaults.
 */
function withFallbackInstanceOptions(input: {
  readonly modelOptions: ProviderOptionSelectionsByProvider | null;
  readonly optionSelections: Partial<Record<string, ModelSelection>> | null;
  readonly selectedModel: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedInstanceId?: ProviderInstanceId | null | undefined;
  readonly requestedInstanceId?: ProviderInstanceId | null | undefined;
  readonly settings: UnifiedSettings;
}): ProviderOptionSelectionsByProvider | null {
  const { modelOptions, selectedInstanceId, requestedInstanceId } = input;
  if (
    !modelOptions ||
    !selectedInstanceId ||
    !requestedInstanceId ||
    selectedInstanceId === requestedInstanceId ||
    modelOptions[selectedInstanceId] !== undefined
  ) {
    return modelOptions;
  }
  const requestedOptions = modelOptions[requestedInstanceId];
  const requestedProvider = input.providers.find(
    (provider) => provider.instanceId === requestedInstanceId,
  );
  const requestedModel = input.optionSelections?.[requestedInstanceId]?.model;
  // Static aliases are shared across instances; exact custom slugs and catalog aliases are not.
  const modelIdentity = (instanceId: ProviderInstanceId, model: string | undefined) => {
    const isCustom =
      input.providers
        .find((provider) => provider.instanceId === instanceId)
        ?.models.some((entry) => entry.slug === model && entry.isCustom) ||
      readInstanceCustomModels(input.settings, instanceId, input.selectedProvider).some(
        (entry) => entry.slug === model,
      );
    return isCustom ? model : normalizeModelSlug(model, input.selectedProvider);
  };
  const sameModel =
    requestedModel === input.selectedModel ||
    modelIdentity(requestedInstanceId, requestedModel) ===
      modelIdentity(selectedInstanceId, input.selectedModel);
  if (!requestedOptions || requestedProvider?.driver !== input.selectedProvider || !sameModel) {
    return modelOptions;
  }
  return { ...modelOptions, [selectedInstanceId]: requestedOptions };
}
