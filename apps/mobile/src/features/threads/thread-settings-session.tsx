import { getPromptControlledTraits, getTraitSelectChange } from "@goat/client-runtime/model-traits";
import { recentModelKeys } from "@goat/client-runtime/model-quick-picks";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  RuntimeMode,
  ServerSettings,
} from "@goat/contracts";
import { getProviderOptionDescriptors } from "@goat/shared/model";
import {
  modelPreferencesMigrationPatch,
  resolveModelPreferences,
} from "@goat/shared/serverSettings";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import * as Haptics from "expo-haptics";
import { AsyncResult } from "effect/reactivity";
import { createContext, use, useEffect, useRef, useState, type ReactNode } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { environmentCatalog } from "../../connection/catalog";
import {
  buildModelOptions,
  groupByProvider,
  type ModelOption,
  type ProviderGroup,
} from "../../lib/modelOptions";
import { applyProviderOptionSelection } from "../../lib/providerOptions";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useEnvironmentQuery } from "../../state/query";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { rememberModelOptions } from "../../state/use-model-option-memory";
import {
  compatibleRuntimeModeForChoices,
  runtimeModeChoicesForSupportedModes,
} from "./thread-settings-options";
import {
  canCommitPendingModel,
  modelFavoriteKey,
  pendingModelAfterPress,
} from "./thread-settings-sheet-state";

const RECENT_MODEL_LIMIT = 8;

const EMPTY_MODEL_FAVORITES: ReadonlyArray<{
  readonly provider: ProviderInstanceId;
  readonly model: string;
}> = [];
export const FAVORITES_PROVIDER_FILTER = "@favorites";
// Servers that predate `migrateModelPreferences` drop it and keep reporting null favorites.
const attemptedMigrationGenerations = new Map<EnvironmentId, number>();

export type ThreadSettingsSubmenuPage =
  | { readonly kind: "descriptor"; readonly id: string }
  | { readonly kind: "runtime" };

export type ThreadSettingsSessionProps = {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly lockedProviderInstanceId?: ProviderInstanceId;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly selectedModel: ModelSelection | null;
  readonly prompt: string;
  readonly onPromptChange: (prompt: string) => void;
  readonly reportedModelSelection?: ModelSelection | null;
  readonly onSelectModel: (option: ModelOption) => void;
  readonly restoreSelection?: (selection: ModelSelection) => ModelSelection;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly onUpdateOptionSelections: (selections: ReadonlyArray<ProviderOptionSelection>) => void;
  readonly runtimeMode: RuntimeMode;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
};

export type ThreadSettingsSessionValue = {
  readonly environmentId: EnvironmentId | null;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  /** The thread's model, even when the catalog hides it; null only when no provider lists it. */
  readonly appliedModel: ModelOption | null;
  /** The pending model, else the applied one. */
  readonly displayedModel: ModelOption | null;
  readonly recentModelKeys: ReadonlyArray<string>;
  /** Drops the pending model, even when the applied one is hidden or no longer listed. */
  readonly keepAppliedModel: () => void;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly favoritesLoaded: boolean;
  readonly toggleFavorite: (option: ModelOption) => void;
  readonly toggleHidden: (option: ModelOption) => void;
  readonly pendingHiddenKeys: ReadonlySet<string>;
  readonly manageHidden: boolean;
  readonly setManageHidden: (value: boolean) => void;
  readonly runtimeMode: RuntimeMode;
  readonly runtimeModeChoices: ReturnType<typeof runtimeModeChoicesForSupportedModes>;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
  readonly displayedDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly promptTraits: ReturnType<typeof getPromptControlledTraits>;
  readonly displayedModelSelection: ModelSelection | null;
  readonly reportedModelSelection: ModelSelection | null;
  readonly providerExpansionOverrides: ReadonlySet<string>;
  readonly hasLegacyModels: boolean;
  readonly pendingModel: ModelOption | null;
  readonly providerFilter: string | null;
  readonly searchQuery: string;
  readonly showLegacy: boolean;
  readonly applyOptionChange: (id: string, value: string | boolean) => void;
  readonly commitPendingModel: () => boolean;
  readonly isApplied: (option: ModelOption) => boolean;
  readonly isDisplayed: (option: ModelOption) => boolean;
  readonly pressModel: (option: ModelOption) => void;
  readonly setProviderFilter: (providerKey: string | null) => void;
  readonly setSearchQuery: (query: string) => void;
  readonly setShowLegacy: (showLegacy: boolean) => void;
  readonly toggleProvider: (providerKey: string) => void;
};

const ThreadSettingsSessionContext = createContext<ThreadSettingsSessionValue | null>(null);

export function ThreadSettingsSessionProvider(
  props: ThreadSettingsSessionProps & { readonly children: ReactNode },
) {
  const registry = use(RegistryContext);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const config = props.environmentId ? configs.get(props.environmentId) : undefined;
  const settings = config?.settings;
  const connection = useEnvironmentQuery(
    props.environmentId ? environmentCatalog.stateAtom(props.environmentId) : null,
  ).data;
  const connectionGeneration = connection?.phase === "connected" ? connection.generation : null;
  // Read once per environment so rows hold still while the sheet is open and streaming threads
  // do not re-render it.
  const readRecents = (environmentId: EnvironmentId | null) => ({
    environmentId,
    keys: environmentId
      ? recentModelKeys(
          registry.get(environmentThreadShells.threadShellsAtom),
          environmentId,
          RECENT_MODEL_LIMIT,
        )
      : [],
  });
  const [recents, setRecents] = useState(() => readRecents(props.environmentId));
  if (recents.environmentId !== props.environmentId) {
    setRecents(readRecents(props.environmentId));
  }
  const [manageHidden, setManageHidden] = useState(false);
  const pendingHidden = useRef(new Set<string>());
  const pendingFavorites = useRef(
    new Map<string, { favorite: boolean; settings: ServerSettings; pending: boolean }>(),
  );
  const [pendingHiddenKeys, setPendingHiddenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const providerGroups =
    manageHidden && config
      ? groupByProvider(
          buildModelOptions(
            config,
            props.selectedModel,
            props.lockedProviderInstanceId,
            props.projectId,
            true,
          ),
        )
      : props.providerGroups;
  const legacyFavorites = AsyncResult.isSuccess(preferences)
    ? (preferences.value.modelFavorites ?? EMPTY_MODEL_FAVORITES)
    : EMPTY_MODEL_FAVORITES;
  const favoritesLoaded =
    settings !== undefined && (settings.favorites !== null || AsyncResult.isSuccess(preferences));
  const modelFavorites = resolveModelPreferences(settings ?? DEFAULT_SERVER_SETTINGS, {
    favorites: legacyFavorites,
  }).favorites;
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, "model favorites update");
  useEffect(() => {
    if (
      !props.environmentId ||
      !settings ||
      !AsyncResult.isSuccess(preferences) ||
      connectionGeneration === null ||
      attemptedMigrationGenerations.get(props.environmentId) === connectionGeneration
    )
      return;
    const patch = modelPreferencesMigrationPatch(settings, { favorites: legacyFavorites });
    if (!patch) return;
    attemptedMigrationGenerations.set(props.environmentId, connectionGeneration);
    void saveSettings({ environmentId: props.environmentId, input: { patch } });
  }, [
    connectionGeneration,
    legacyFavorites,
    preferences,
    props.environmentId,
    saveSettings,
    settings,
  ]);
  const favoriteKeys = new Set(
    modelFavorites.map((favorite) => modelFavoriteKey(favorite.provider, favorite.model)),
  );
  const toggleFavorite = async (option: ModelOption) => {
    const environmentId = props.environmentId;
    if (!favoritesLoaded || !environmentId) return;
    const currentSettings = registry.get(environmentServerConfigsAtom).get(environmentId)?.settings;
    if (!currentSettings) return;
    const favorites = resolveModelPreferences(currentSettings, {
      favorites: legacyFavorites,
    }).favorites;
    const key = JSON.stringify([
      environmentId,
      option.selection.instanceId,
      option.selection.model,
    ]);
    const previous = pendingFavorites.current.get(key);
    const previousFavorite =
      previous && (previous.pending || previous.settings.favorites === currentSettings.favorites)
        ? previous.favorite
        : favorites.some(
            (favorite) =>
              favorite.provider === option.selection.instanceId &&
              favorite.model === option.selection.model,
          );
    const pending = { favorite: !previousFavorite, settings: currentSettings, pending: true };
    pendingFavorites.current.set(key, pending);
    void Haptics.selectionAsync();
    const result = await saveSettings({
      environmentId: environmentId,
      input: {
        patch: {
          setModelFavorites: [
            {
              provider: option.selection.instanceId,
              model: option.selection.model,
              favorite: pending.favorite,
            },
          ],
          ...(currentSettings.favorites === null ? { migrateModelPreferences: { favorites } } : {}),
        },
      },
    });
    if (
      AsyncResult.isSuccess(result) &&
      registry.get(environmentServerConfigsAtom).get(environmentId)?.settings.favorites ===
        currentSettings.favorites
    ) {
      pending.pending = false;
    }
    if (pending.pending && pendingFavorites.current.get(key) === pending) {
      if (
        previous &&
        !previous.pending &&
        registry.get(environmentServerConfigsAtom).get(environmentId)?.settings.favorites ===
          previous.settings.favorites
      ) {
        pendingFavorites.current.set(key, previous);
      } else {
        pendingFavorites.current.delete(key);
      }
    }
  };
  const toggleHidden = (option: ModelOption) => {
    if (
      !settings ||
      !props.environmentId ||
      !option.canHide ||
      pendingHidden.current.has(option.key)
    )
      return;
    pendingHidden.current.add(option.key);
    setPendingHiddenKeys(new Set(pendingHidden.current));
    void Haptics.selectionAsync();
    void saveSettings({
      environmentId: props.environmentId,
      input: {
        patch: {
          setModelsHidden: [
            {
              provider: option.selection.instanceId,
              model: option.selection.model,
              hidden: !option.isHidden,
            },
          ],
        },
      },
    }).then(() => {
      pendingHidden.current.delete(option.key);
      setPendingHiddenKeys(new Set(pendingHidden.current));
    });
  };
  const [showLegacyToggle, setShowLegacyToggle] = useState(false);
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [providerExpansionOverrides, setProviderExpansionOverrides] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingModel, setPendingModel] = useState<ModelOption | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const displayedPrompt = pendingModel ? (pendingPrompt ?? props.prompt) : props.prompt;

  const isApplied = (option: ModelOption) =>
    option.selection.instanceId === props.selectedModel?.instanceId &&
    option.selection.model === props.selectedModel.model;
  const isDisplayed = (option: ModelOption) =>
    pendingModel ? option.key === pendingModel.key : isApplied(option);

  const displayedDescriptors = pendingModel
    ? pendingModel.capabilities
      ? getProviderOptionDescriptors({
          caps: pendingModel.capabilities,
          selections: pendingModel.selection.options,
        })
      : []
    : props.optionDescriptors;
  const promptTraits = getPromptControlledTraits(displayedDescriptors, displayedPrompt);
  const findApplied = (groups: ReadonlyArray<ProviderGroup>) =>
    groups.flatMap((group) => group.models).find((option) => isApplied(option));
  const appliedModel =
    findApplied(providerGroups) ??
    (config && props.selectedModel
      ? findApplied(
          groupByProvider(
            buildModelOptions(
              config,
              props.selectedModel,
              props.lockedProviderInstanceId,
              props.projectId,
              true,
            ),
          ),
        )
      : undefined) ??
    null;
  const displayedModel = pendingModel ?? appliedModel;
  const runtimeModeChoices = runtimeModeChoicesForSupportedModes(
    displayedModel?.supportedRuntimeModes,
  );
  const compatibleRuntimeMode = compatibleRuntimeModeForChoices(
    props.runtimeMode,
    runtimeModeChoices,
  );

  const hasLegacyModels = props.providerGroups.some((group) =>
    group.models.some((model) => model.isLegacy),
  );
  const commitPendingModel = () => {
    if (pendingModel) {
      if (!canCommitPendingModel(pendingModel, props.providerGroups)) {
        Dialog.alert(
          "Model unavailable",
          "Set up this provider on web or desktop, or select another model.",
        );
        return false;
      }
      void Haptics.selectionAsync();
      props.onSelectModel(pendingModel);
      if (pendingPrompt !== null && pendingPrompt !== props.prompt) {
        props.onPromptChange(pendingPrompt);
      }
    }
    return true;
  };

  const applyOptionChange = (id: string, value: string | boolean) => {
    const descriptor = displayedDescriptors.find((entry) => entry.id === id);
    const change =
      descriptor?.type === "select" && typeof value === "string"
        ? getTraitSelectChange(
            { ...promptTraits, descriptors: displayedDescriptors },
            descriptor,
            displayedPrompt,
            value,
          )
        : null;
    if (descriptor?.type === "select") {
      if (!change) return;
      if (change.prompt !== displayedPrompt) {
        if (pendingModel) {
          setPendingPrompt(change.prompt);
        } else {
          props.onPromptChange(change.prompt);
        }
      }
      if (!("modelOptions" in change)) return;
    }
    const next =
      change && "modelOptions" in change
        ? (change.modelOptions ?? [])
        : applyProviderOptionSelection(displayedDescriptors, { id, value });
    if (!next) {
      return;
    }
    if (pendingModel) {
      rememberModelOptions(pendingModel.selection.instanceId, pendingModel.selection.model, next);
      setPendingModel({
        ...pendingModel,
        selection: { ...pendingModel.selection, options: next },
      });
    } else {
      props.onUpdateOptionSelections(next);
    }
  };

  const toggleProvider = (providerKey: string) => {
    setProviderExpansionOverrides((current) => {
      const next = new Set(current);
      if (!next.delete(providerKey)) {
        next.add(providerKey);
      }
      return next;
    });
  };

  const pressModel = (option: ModelOption) => {
    void Haptics.selectionAsync();
    if (isApplied(option) || option.key !== pendingModel?.key) {
      setPendingPrompt(null);
    }
    setPendingModel((current) =>
      pendingModelAfterPress({
        current,
        pressed: option,
        pressedIsApplied: isApplied(option),
        restoreSelection: props.restoreSelection,
      }),
    );
  };

  const value = {
    environmentId: props.environmentId,
    providerInstanceId: props.providerInstanceId,
    providerGroups,
    appliedModel,
    displayedModel,
    recentModelKeys: recents.keys,
    keepAppliedModel: () => {
      setPendingModel(null);
      setPendingPrompt(null);
    },
    manageHidden,
    setManageHidden,
    toggleHidden,
    pendingHiddenKeys,
    runtimeMode: compatibleRuntimeMode,
    runtimeModeChoices,
    onUpdateRuntimeMode: props.onUpdateRuntimeMode,
    displayedDescriptors,
    promptTraits,
    displayedModelSelection: pendingModel?.selection ?? props.selectedModel,
    reportedModelSelection: pendingModel ? null : (props.reportedModelSelection ?? null),
    favoriteKeys,
    favoritesLoaded,
    providerExpansionOverrides,
    hasLegacyModels,
    pendingModel,
    providerFilter,
    searchQuery,
    showLegacy: showLegacyToggle,
    applyOptionChange,
    commitPendingModel,
    isApplied,
    isDisplayed,
    pressModel,
    setProviderFilter,
    setSearchQuery,
    setShowLegacy: setShowLegacyToggle,
    toggleProvider,
    toggleFavorite,
  } satisfies ThreadSettingsSessionValue;

  return (
    <ThreadSettingsSessionContext.Provider value={value}>
      {props.children}
    </ThreadSettingsSessionContext.Provider>
  );
}

export function useThreadSettingsSession() {
  const value = use(ThreadSettingsSessionContext);
  if (!value) {
    throw new Error("useThreadSettingsSession must be used inside ThreadSettingsSessionProvider.");
  }
  return value;
}
