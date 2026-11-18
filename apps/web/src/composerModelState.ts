import { draftModelSelectionApplies } from "./lib/chatThreadActions";
import { useShallow } from "zustand/react/shallow";
import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  ProviderInstanceId,
  type ProviderDriverKind,
  type ServerProvider,
} from "@goat/contracts";
import type { UnifiedSettings } from "@goat/contracts/settings";
import { normalizeModelSlug, resolveSelectableModel } from "@goat/shared/model";

import {
  type ComposerThreadTarget,
  type ComposerThreadDraftState,
  type ProviderOptionSelectionsByProvider,
  useComposerDraftStore,
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

// Catalog aliases and exact custom slugs are scoped to their provider instance.
function composerModelIdentity(
  input: {
    providers: ReadonlyArray<ServerProvider>;
    settings: UnifiedSettings;
    selectedProvider: ProviderDriverKind;
  },
  instanceId: ProviderInstanceId,
  model: string | undefined,
): string | null {
  const catalog =
    input.providers.find((provider) => provider.instanceId === instanceId)?.models ?? [];
  const custom = readInstanceCustomModels(input.settings, instanceId, input.selectedProvider);
  if (model !== undefined && custom.some((entry) => entry.slug === model)) return model;
  const resolved = resolveSelectableModel(input.selectedProvider, model, catalog) ?? model;
  return resolved !== undefined &&
    catalog.some((entry) => entry.slug === resolved && entry.isCustom)
    ? resolved
    : normalizeModelSlug(resolved, input.selectedProvider);
}

export function deriveEffectiveComposerModelState(input: {
  draft:
    | Pick<
        ComposerThreadDraftState,
        "modelSelectionByProvider" | "activeProvider" | "modelSelectionExplicit"
      >
    | null
    | undefined;
  threadStarted?: boolean;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderDriverKind;
  selectedInstanceId?: ProviderInstanceId | null | undefined;
  /** The instance the draft, thread or project asked for; differs from the selection on fallback. */
  requestedInstanceId?: ProviderInstanceId | null | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const draft = draftModelSelectionApplies(input.draft, input.threadStarted ?? false)
    ? input.draft
    : null;
  const baseSelection = input.threadModelSelection ?? input.projectModelSelection;
  const baseModelCandidate = baseSelection?.model ?? null;
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
    ? draft?.modelSelectionByProvider?.[input.selectedInstanceId]
    : undefined;
  // Legacy driver-keyed drafts belong to the default instance.
  const legacySelection =
    input.selectedInstanceId &&
    input.selectedInstanceId !== defaultInstanceIdForDriver(input.selectedProvider)
      ? undefined
      : draft?.modelSelectionByProvider?.[ProviderInstanceId.make(input.selectedProvider)];
  const activeSelection = instanceSelection ?? legacySelection;
  const activeSelectionInstanceId =
    input.selectedInstanceId ?? defaultInstanceIdForDriver(input.selectedProvider);
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
  const selectedIdentity = composerModelIdentity(input, activeSelectionInstanceId, selectedModel);
  // With no draft pick, saved defaults follow the same capability validation as Settings.
  const baseMatchesSelection =
    !activeSelection ||
    (baseSelection?.instanceId === activeSelectionInstanceId &&
      composerModelIdentity(input, baseSelection.instanceId, baseSelection.model) ===
        selectedIdentity);
  const draftSelections = { ...draft?.modelSelectionByProvider };
  if (
    activeSelection &&
    composerModelIdentity(input, activeSelectionInstanceId, activeSelection.model) !==
      selectedIdentity
  ) {
    delete draftSelections[activeSelectionInstanceId];
  }
  const optionSelections =
    [draftSelections, baseMatchesSelection ? selectionsByInstance(baseSelection) : null].find(
      (selections) => modelSelectionByProviderToOptions(selections) !== null,
    ) ?? null;
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
  const sameModel =
    composerModelIdentity(input, requestedInstanceId, requestedModel) ===
    composerModelIdentity(input, selectedInstanceId, input.selectedModel);
  if (!requestedOptions || requestedProvider?.driver !== input.selectedProvider || !sameModel) {
    return modelOptions;
  }
  return { ...modelOptions, [selectedInstanceId]: requestedOptions };
}

interface ComposerDraftModelState {
  activeProvider: ProviderInstanceId | null;
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  modelSelectionExplicit?: boolean;
}

const EMPTY_COMPOSER_DRAFT_MODEL_STATE = Object.freeze<ComposerDraftModelState>({
  activeProvider: null,
  modelSelectionByProvider: Object.freeze({}),
});

export function useComposerDraftModelState(
  threadRef: ComposerThreadTarget,
  threadStarted = false,
): ComposerDraftModelState {
  return useComposerDraftStore(
    useShallow((state) => {
      const draft = state.getComposerDraft(threadRef);
      return draft && draftModelSelectionApplies(draft, threadStarted)
        ? {
            activeProvider: draft.activeProvider,
            modelSelectionByProvider: draft.modelSelectionByProvider,
            modelSelectionExplicit: draft.modelSelectionExplicit === true,
          }
        : EMPTY_COMPOSER_DRAFT_MODEL_STATE;
    }),
  );
}
