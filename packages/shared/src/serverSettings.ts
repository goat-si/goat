import { mergeSourceControlHostSettings } from "./sourceControlHostSettings.ts";
import type { ModelPreferences } from "@goat/contracts/settings";
import {
  goatBotHomeClaimSupersedes,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  globalIdleCompaction,
  type IdleCompactionMode,
  isProviderAvailable,
  isUnconfiguredDefaultInstanceEnabled,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  isProviderTextGenerationCapable,
  type ModelSelection,
  patchDisposableMachines,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ServerSettings,
  type ServerSettingsPatch,
  UsageLimitSourceId,
  withIdleCompaction,
} from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection, readCustomModelEntries } from "./model.ts";
import {
  getBackgroundActivityBaseProfile,
  normalizeBackgroundActivitySettings,
  normalizeServerBackgroundActivitySettings,
  resolveBackgroundActivitySettings,
} from "./backgroundActivitySettings.ts";

// Only observability: a value the server migrates on load elsewhere in the file must not drop it.
const ServerObservabilitySettingsJson = fromLenientJson(
  Schema.Struct({ observability: ServerSettings.fields.observability }),
);
const decodeServerObservabilitySettingsJson = Schema.decodeUnknownOption(
  ServerObservabilitySettingsJson,
);

export function resolveProjectAgentBrowserAccess(
  settings: Pick<
    ServerSettings,
    "enableAgentBrowserAccess" | "projectAgentBrowserAccessOverrides" | "projectSettingsOverrides"
  >,
  projectId: ProjectId,
): boolean {
  return (
    settings.projectSettingsOverrides[projectId]?.enableAgentBrowserAccess ??
    settings.projectAgentBrowserAccessOverrides[projectId] ??
    settings.enableAgentBrowserAccess
  );
}

export function resolveProjectAutoPull(
  settings: Pick<
    ServerSettings,
    "defaultAutoPull" | "projectAutoPullOverrides" | "projectSettingsOverrides"
  >,
  projectId: ProjectId,
  legacyAutoPull: boolean | undefined,
): boolean {
  return (
    settings.projectSettingsOverrides[projectId]?.defaultAutoPull ??
    settings.projectAutoPullOverrides[projectId] ??
    (legacyAutoPull === true || settings.defaultAutoPull)
  );
}

// Settings from an older server, or partial test settings, may lack textGenerators.
function textGenerator(settings: ServerSettings, instanceId: ModelSelection["instanceId"]) {
  const generators = settings.textGenerators ?? {};
  return Object.hasOwn(generators, instanceId) ? generators[instanceId] : undefined;
}

export function isModelSelectionProviderEnabled(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  const generator = textGenerator(settings, selection.instanceId);
  if (generator !== undefined) return generator.enabled;
  const instanceConfig = Object.hasOwn(settings.providerInstances, selection.instanceId)
    ? settings.providerInstances[selection.instanceId]
    : undefined;
  if (instanceConfig !== undefined) {
    return resolveProviderInstanceEnabled(instanceConfig);
  }

  return isUnconfiguredDefaultInstanceEnabled(selection.instanceId);
}

const TEXT_GENERATION_FALLBACK_DRIVERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "muse",
  "pi",
  "omo",
  "opencode",
  "antigravity",
].map((driver) => ProviderDriverKind.make(driver));

/** Only project-scoped callers may include configured instances when falling back; machine-level callers leave it unset. */
export function fallbackTextGenerationModelSelection(
  providerInstances: ServerSettings["providerInstances"],
  isEnabled: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => boolean,
  options?: {
    readonly includeConfiguredInstances?: boolean;
    readonly defaultModelSelection?: ModelSelection | null;
  },
): ModelSelection | null {
  const candidates = [
    ...TEXT_GENERATION_FALLBACK_DRIVERS.map(
      (driver) => [defaultInstanceIdForDriver(driver), driver] as const,
    ),
    ...(options?.includeConfiguredInstances === true
      ? Object.entries(providerInstances).flatMap(([instanceId, instance]) =>
          TEXT_GENERATION_FALLBACK_DRIVERS.includes(instance.driver)
            ? [[ProviderInstanceId.make(instanceId), instance.driver] as const]
            : [],
        )
      : []),
  ];
  const match = candidates.find(([instanceId, driver]) => isEnabled(instanceId, driver));
  if (match === undefined) return null;
  const [instanceId, driver] = match;
  const threadDefault = options?.defaultModelSelection;
  const config = providerInstances[instanceId]?.config as { customModels?: unknown } | undefined;
  if (
    threadDefault?.instanceId === instanceId &&
    readCustomModelEntries(config?.customModels).some((entry) => entry.slug === threadDefault.model)
  ) {
    return threadDefault;
  }
  return {
    instanceId,
    model:
      DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[driver] ??
      DEFAULT_MODEL_BY_PROVIDER[driver] ??
      DEFAULT_TEXT_GENERATION_MODEL,
  };
}

export function resolveSourceControlWriterModelSelection(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | undefined,
  projectId: ProjectId | null,
): ModelSelection {
  const selection = settings.sourceControlWriterModelSelection;
  const generator = selection ? textGenerator(settings, selection.instanceId) : undefined;
  if (generator !== undefined)
    return generator.enabled
      ? (selection ?? settings.textGenerationModelSelection)
      : settings.textGenerationModelSelection;
  if (
    !selection ||
    !resolveProjectProviderInstanceEnabled(settings, projectId, selection.instanceId)
  ) {
    return settings.textGenerationModelSelection;
  }
  if (providers === undefined) {
    return selection;
  }

  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  return provider?.enabled === true &&
    isProviderAvailable(provider) &&
    isProviderTextGenerationCapable(provider)
    ? selection
    : settings.textGenerationModelSelection;
}

/**
 * The model memory generation runs on. Without a usable dedicated choice it follows the
 * text generation model, which the server already moves to a ready provider.
 */
export function resolveMemoryModelSelection(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | undefined,
): ModelSelection {
  const selection = resolveSourceControlWriterModelSelection(
    { ...settings, sourceControlWriterModelSelection: settings.memoryModelSelection },
    providers,
    null,
  );
  return agentOnlySelection(settings, providers, null, selection, false);
}

function agentOnlySelection(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | undefined,
  projectId: ProjectId | null,
  selection: ModelSelection,
  investigate: boolean,
): ModelSelection {
  const instanceId = selection?.instanceId;
  if (instanceId === undefined || textGenerator(settings, instanceId) === undefined)
    return selection;
  return (
    fallbackTextGenerationModelSelection(
      settings.providerInstances,
      (id, driver) => {
        if (textGenerator(settings, id) !== undefined) return false;
        if (investigate && driver !== "codex" && driver !== "claudeAgent") return false;
        if (!resolveProjectProviderInstanceEnabled(settings, projectId, id)) return false;
        if (providers === undefined) return true;
        const provider = providers.find((candidate) => candidate.instanceId === id);
        return (
          provider?.enabled === true &&
          isProviderAvailable(provider) &&
          isProviderTextGenerationCapable(provider)
        );
      },
      { includeConfiguredInstances: true },
    ) ?? selection
  );
}

export function resolveReviewGuideModelSelection(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | undefined,
  projectId: ProjectId | null,
): ModelSelection {
  const selection = settings.reviewGuideModelSelection;
  if (
    selection &&
    textGenerator(settings, selection.instanceId) === undefined &&
    resolveProjectProviderInstanceEnabled(settings, projectId, selection.instanceId)
  ) {
    const provider = providers?.find((candidate) => candidate.instanceId === selection.instanceId);
    if (
      providers === undefined ||
      (provider?.enabled === true &&
        isProviderAvailable(provider) &&
        isProviderTextGenerationCapable(provider))
    ) {
      return selection;
    }
  }
  return agentOnlySelection(
    settings,
    providers,
    projectId,
    resolveSourceControlWriterModelSelection(settings, providers, projectId),
    true,
  );
}

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
  readonly otlpLogsUrl: string | undefined;
}

function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
    readonly otlpLogsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
    otlpLogsUrl: normalizePersistedServerSettingString(input.observability?.otlpLogsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  const decoded = decodeServerObservabilitySettingsJson(raw);
  if (Option.isSome(decoded)) {
    return extractPersistedServerObservabilitySettings(decoded.value);
  }
  return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined, otlpLogsUrl: undefined };
}

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

function mergeSettingsEntries<Value>(
  current: Readonly<Record<string, Value>>,
  patch: Readonly<Record<string, Value | null>>,
): Record<string, Value> {
  const next = new Map(Object.entries(current));
  for (const [id, config] of Object.entries(patch)) {
    if (config === null) {
      next.delete(id);
    } else {
      next.set(id, config);
    }
  }
  return Object.fromEntries(next);
}

function mergeUsageLimitSources(
  current: ServerSettings["usageLimitSources"],
  patch: NonNullable<ServerSettingsPatch["usageLimitSources"]>,
) {
  return mergeSettingsEntries(
    current,
    Object.fromEntries(
      Object.entries(patch).map(([id, next]) => {
        const previous = current[UsageLimitSourceId.make(id)];
        return [
          id,
          next !== null &&
          next.managementKeyReference === undefined &&
          (next.managementKey === "" || next.managementKey === "••••••") &&
          previous?.managementKeyReference != null
            ? { ...next, managementKeyReference: previous.managementKeyReference }
            : next,
        ];
      }),
    ),
  );
}

/** Top-level fields replace; each named target merges its patched fields, and `null` removes it. */
function mergeCompletionWebhook(
  current: ServerSettings["completionWebhook"],
  patch: NonNullable<ServerSettingsPatch["completionWebhook"]>,
): ServerSettings["completionWebhook"] {
  const { targets: targetsPatch, ...fields } = patch;
  if (targetsPatch === undefined) return { ...current, ...fields };
  const targets = { ...current.targets };
  for (const [name, target] of Object.entries(targetsPatch)) {
    if (target === null) {
      delete targets[name];
    } else {
      targets[name] = { url: "", secret: "", ...targets[name], ...target };
    }
  }
  return { ...current, ...fields, targets };
}

// Older clients replace whole project entries without newer provider/skill maps.
// Preserve omitted maps and keep builtInSkills when null clears visible overrides;
// project cleanup uses PROJECT_SETTINGS_OVERRIDES_REMOVAL instead.
function mergeProjectSettingsOverridesPatch(
  current: Readonly<Record<string, ProjectSettingsOverrides>>,
  patch: Readonly<Record<string, ProjectSettingsOverrides | null>>,
): Record<string, ProjectSettingsOverrides> {
  const next = new Map(Object.entries(current));
  for (const [projectId, entry] of Object.entries(patch)) {
    const stored = current[projectId];
    const kept = <K extends "providerInstances" | "builtInSkills">(key: K) =>
      (entry !== null && Object.hasOwn(entry, key)) || stored?.[key] === undefined
        ? {}
        : { [key]: stored[key] };
    const merged: ProjectSettingsOverrides =
      entry === null
        ? kept("builtInSkills")
        : { ...entry, ...kept("providerInstances"), ...kept("builtInSkills") };
    if (holdsNoOverride(merged)) next.delete(projectId);
    else next.set(projectId, merged);
  }
  return Object.fromEntries(next);
}

/** Nothing set, or only empty per-instance or per-skill maps. */
function holdsNoOverride(entry: ProjectSettingsOverrides): boolean {
  return Object.entries(entry).every(
    ([key, value]) =>
      value === undefined ||
      ((key === "providerInstances" || key === "builtInSkills") &&
        Object.keys(value as object).length === 0),
  );
}

export function deriveLegacyProjectOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
): Pick<
  ServerSettings,
  "projectAgentBrowserAccessOverrides" | "projectAutoPullOverrides" | "projectScriptOverrides"
> {
  const projectAgentBrowserAccessOverrides: Record<string, boolean> = {};
  const projectAutoPullOverrides: Record<string, boolean> = {};
  const projectScriptOverrides: Record<string, ServerSettings["defaultProjectScripts"] | null> = {};
  for (const [projectId, entry] of Object.entries(settings.projectSettingsOverrides)) {
    if (entry.enableAgentBrowserAccess !== undefined) {
      projectAgentBrowserAccessOverrides[projectId] = entry.enableAgentBrowserAccess;
    }
    if (entry.defaultAutoPull !== undefined) {
      projectAutoPullOverrides[projectId] = entry.defaultAutoPull;
    }
    if (entry.defaultProjectScripts !== undefined) {
      projectScriptOverrides[projectId] = entry.defaultProjectScripts;
    }
  }
  return { projectAgentBrowserAccessOverrides, projectAutoPullOverrides, projectScriptOverrides };
}

function translateLegacyProjectOverridePatch(
  current: Pick<ServerSettings, "projectSettingsOverrides">,
  patch: ServerSettingsPatch,
): ServerSettingsPatch {
  const {
    projectAgentBrowserAccessOverrides,
    projectAutoPullOverrides,
    projectScriptOverrides,
    ...rest
  } = patch;
  if (
    projectAgentBrowserAccessOverrides === undefined &&
    projectAutoPullOverrides === undefined &&
    projectScriptOverrides === undefined
  ) {
    return patch;
  }
  const currentEntries: Readonly<Record<string, ProjectSettingsOverrides>> =
    current.projectSettingsOverrides;
  const entries = new Map<string, ProjectSettingsOverrides | null>(
    Object.entries(rest.projectSettingsOverrides ?? {}),
  );
  // Canonical entries outrank legacy maps, including deliberately omitted keys.
  const canonicalProjectIds = new Set(Object.keys(rest.projectSettingsOverrides ?? {}));
  const applyKey = <K extends ProjectScopedServerSettingKey>(
    map: Readonly<Record<string, ProjectSettingsOverrides[K] | null>> | undefined,
    key: K,
  ) => {
    if (map === undefined) return;
    for (const [projectId, value] of Object.entries(map)) {
      if (canonicalProjectIds.has(projectId)) continue;
      const entry: ProjectSettingsOverrides = {
        ...(entries.get(projectId) ?? currentEntries[projectId]),
      };
      if (value === null || value === undefined) {
        delete entry[key];
      } else {
        entry[key] = value;
      }
      entries.set(projectId, Object.keys(entry).length === 0 ? null : entry);
    }
  };
  applyKey(projectAgentBrowserAccessOverrides, "enableAgentBrowserAccess");
  applyKey(projectAutoPullOverrides, "defaultAutoPull");
  applyKey(projectScriptOverrides, "defaultProjectScripts");
  return {
    ...rest,
    projectSettingsOverrides: Object.fromEntries(entries),
  } as ServerSettingsPatch;
}

/** Generic patches cannot change the independently versioned memory hub configuration. */
export function assertNoMemoryHubSettingsPatch(patch: unknown): void {
  if (
    patch !== null &&
    typeof patch === "object" &&
    (Object.hasOwn(patch, "memoryHub") ||
      Object.hasOwn(patch, "memoryHubVersion") ||
      Object.hasOwn(patch, "memoryHubProvenance"))
  ) {
    throw new Error("Memory hub settings require a dedicated transition.");
  }
}

/**
 * A client from before `idleCompaction` patches the old boolean switch. Turning
 * it off keeps "Never" rather than reverting to the default.
 */
function patchedIdleCompaction(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): IdleCompactionMode {
  if (patch.idleCompaction !== undefined) return patch.idleCompaction;
  const legacy = patch.compactIdleThreads;
  if (legacy === undefined) return globalIdleCompaction(current);
  if (typeof legacy === "string") return legacy;
  if (legacy) return "beforeCacheExpires";
  return globalIdleCompaction(current) === "off" ? "off" : "onReturn";
}

export function applyServerSettingsPatch(
  current: ServerSettings,
  rawPatch: ServerSettingsPatch,
): ServerSettings {
  assertNoMemoryHubSettingsPatch(rawPatch);
  const patch = translateLegacyProjectOverridePatch(current, rawPatch);
  const selectionPatch = patch.textGenerationModelSelection;
  const {
    migrateModelPreferences,
    setModelFavorites,
    setModelsHidden,
    setProviderModelOrder,
    providerModelPreferences,
    automaticGitFetchInterval,
    providerHealthRefreshInterval,
    backgroundActivityProfile,
    backgroundActivity,
    worktreeCleanup: worktreeCleanupPatch,
    // Merged per entry below; its `null` removals must not reach deepMerge.
    mcpServers: mcpServersPatch,
    usageLimitSources: usageLimitSourcesPatch,
    textGenerators: textGeneratorsPatch,
    easDeviceHosts: easDeviceHostsPatch,
    secretProviders: secretProvidersPatch,
    sourceControlHosts: sourceControlHostsPatch,
    usagePriceOverrides: usagePriceOverridesPatch,
    usageModelAliases: usageModelAliasesPatch,
    usageModelFilter: usageModelFilterPatch,
    // Entry replacement: deepMerge would keep keys the client meant to clear.
    projectSettingsOverrides: projectSettingsOverridesPatch,
    projectAgentBrowserAccessOverrides: _legacyBrowserAccess,
    projectAutoPullOverrides: _legacyAutoPull,
    projectScriptOverrides: _legacyScripts,
    // Claims only move forward; a smaller one (a delayed resync) is ignored below.
    goatBotHome: goatBotHomePatch,
    // Its targets merge per name below; their `null` removals must not reach deepMerge.
    completionWebhook: completionWebhookPatch,
    // Per top-level key: deepMerge would keep a fallback chain or host limit the patch removed.
    fleet: fleetPatch,
    goatclaw: goatclawPatch,
    hub: hubPatch,
    ...patchForMerge
  } = patch;
  const currentBackgroundActivity = normalizeServerBackgroundActivitySettings(current);
  const backgroundActivityPatch =
    backgroundActivityProfile !== undefined
      ? {
          schemaVersion: 1 as const,
          profile:
            automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
              ? ("custom" as const)
              : backgroundActivityProfile,
          ...(automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
            ? { baseProfile: backgroundActivityProfile }
            : {}),
          overrides: {
            ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
            ...(providerHealthRefreshInterval !== undefined
              ? { providerHealthRefreshInterval }
              : {}),
          },
        }
      : automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
        ? {
            schemaVersion: 1 as const,
            profile: "custom" as const,
            baseProfile: getBackgroundActivityBaseProfile(currentBackgroundActivity),
            overrides: {
              ...(currentBackgroundActivity.profile === "custom"
                ? currentBackgroundActivity.overrides
                : {}),
              ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
              ...(providerHealthRefreshInterval !== undefined
                ? { providerHealthRefreshInterval }
                : {}),
            },
          }
        : undefined;
  const initialFavorites =
    patch.favorites ?? current.favorites ?? migrateModelPreferences?.favorites ?? null;
  const favorites =
    setModelFavorites?.reduce(
      (current, change) => {
        const exists = current.some(
          (favorite) => favorite.provider === change.provider && favorite.model === change.model,
        );
        if (change.favorite) {
          if (!exists) current.push({ provider: change.provider, model: change.model });
          return current;
        }
        return current.filter(
          (favorite) => favorite.provider !== change.provider || favorite.model !== change.model,
        );
      },
      [...(initialFavorites ?? [])],
    ) ?? initialFavorites;
  const initialModelPreferences =
    providerModelPreferences ??
    current.providerModelPreferences ??
    migrateModelPreferences?.providerModelPreferences ??
    null;
  let nextModelPreferences = initialModelPreferences;
  if (setModelsHidden?.length) {
    const updated = { ...initialModelPreferences };
    for (const change of setModelsHidden) {
      const preferences = (Object.hasOwn(updated, change.provider)
        ? updated[change.provider]
        : undefined) ?? {
        hiddenModels: [],
        modelOrder: [],
      };
      const hiddenModels = preferences.hiddenModels.filter((model) => model !== change.model);
      if (change.hidden) hiddenModels.push(change.model);
      updated[change.provider] = { ...preferences, hiddenModels };
    }
    nextModelPreferences = updated;
  }
  if (setProviderModelOrder) {
    const preferences = nextModelPreferences?.[setProviderModelOrder.provider] ?? {
      hiddenModels: [],
      modelOrder: [],
    };
    nextModelPreferences = {
      ...nextModelPreferences,
      [setProviderModelOrder.provider]: {
        ...preferences,
        modelOrder: [...setProviderModelOrder.modelOrder],
      },
    };
  }
  const next = deepMerge(current, patchForMerge);
  const nextWithReplacementsBase = {
    ...next,
    favorites,
    providerModelPreferences: nextModelPreferences,
    ...(worktreeCleanupPatch === undefined
      ? {}
      : {
          worktreeCleanup:
            worktreeCleanupPatch?.mode === "custom"
              ? {
                  mode: "custom" as const,
                  rules: {
                    worktreeKeepWhen: next.storageCleanup.worktreeKeepWhen,
                    worktreeAfterDays: next.storageCleanup.worktreeAfterDays,
                    worktreeSettledAfterDays: next.storageCleanup.worktreeSettledAfterDays,
                    worktreeOnMerge: next.storageCleanup.worktreeOnMerge,
                    worktreeOnDelete: next.storageCleanup.worktreeOnDelete,
                    worktreeUnchanged: next.storageCleanup.worktreeUnchanged,
                    worktreeOnArchive: next.storageCleanup.worktreeOnArchive,
                    worktreeSnapshotChanges: next.storageCleanup.worktreeSnapshotChanges,
                    worktreeKeepRecent: next.storageCleanup.worktreeKeepRecent,
                    ...(current.worktreeCleanup?.mode === "custom"
                      ? current.worktreeCleanup.rules
                      : {}),
                    ...worktreeCleanupPatch.rules,
                  },
                }
              : worktreeCleanupPatch,
        }),
    ...(backgroundActivity !== undefined
      ? {
          backgroundActivity: {
            ...deepMerge(currentBackgroundActivity, backgroundActivity),
            ...(backgroundActivity.overrides !== undefined
              ? { overrides: backgroundActivity.overrides }
              : {}),
          },
        }
      : { backgroundActivity: currentBackgroundActivity }),
    ...(backgroundActivity === undefined && backgroundActivityPatch !== undefined
      ? { backgroundActivity: backgroundActivityPatch }
      : {}),
    ...(patch.providerInstances !== undefined
      ? { providerInstances: patch.providerInstances }
      : {}),
    ...(patch.worktreesDirectory !== undefined &&
    patch.worktreesDirectory !== current.worktreesDirectory
      ? {
          previousWorktreesDirectories: [
            ...current.previousWorktreesDirectories.filter(
              (directory) => directory !== patch.worktreesDirectory,
            ),
            ...(current.worktreesDirectory !== "" &&
            !current.previousWorktreesDirectories.includes(current.worktreesDirectory)
              ? [current.worktreesDirectory]
              : []),
          ],
        }
      : {}),
    // Per host, a patched field replaces the saved one: deepMerge would keep a cleared account pin.
    ...(sourceControlHostsPatch !== undefined
      ? {
          sourceControlHosts: {
            ...current.sourceControlHosts,
            ...Object.fromEntries(
              Object.entries(sourceControlHostsPatch).map(([kind, fields]) => [
                kind,
                mergeSourceControlHostSettings(current.sourceControlHosts[kind], fields),
              ]),
            ),
          },
        }
      : {}),
    ...(projectSettingsOverridesPatch !== undefined
      ? {
          projectSettingsOverrides: Object.fromEntries(
            Object.entries(
              mergeProjectSettingsOverridesPatch(
                current.projectSettingsOverrides,
                projectSettingsOverridesPatch,
              ),
            ).filter(([, entry]) => Object.keys(entry).length > 0),
          ),
        }
      : {}),
    ...(fleetPatch !== undefined ? { fleet: { ...current.fleet, ...fleetPatch } } : {}),
    ...(goatclawPatch !== undefined ? { goatclaw: { ...current.goatclaw, ...goatclawPatch } } : {}),
    ...(hubPatch !== undefined
      ? {
          hub: {
            ...current.hub,
            ...hubPatch,
            attachDisposableMachines: patchDisposableMachines(
              current.hub.attachDisposableMachines,
              hubPatch.attachDisposableMachines,
            ),
          },
        }
      : {}),
    ...(patch.defaultModelSelection !== undefined
      ? { defaultModelSelection: patch.defaultModelSelection }
      : {}),
    ...(patch.defaultProjectScripts !== undefined
      ? { defaultProjectScripts: patch.defaultProjectScripts }
      : {}),
    ...(mcpServersPatch !== undefined
      ? {
          mcpServers: Object.fromEntries(
            Object.entries({ ...current.mcpServers, ...mcpServersPatch }).flatMap(
              ([name, server]) => (server === null ? [] : [[name, server] as const]),
            ),
          ),
        }
      : {}),
    ...(usageLimitSourcesPatch !== undefined
      ? {
          usageLimitSources: mergeUsageLimitSources(
            current.usageLimitSources,
            usageLimitSourcesPatch,
          ),
        }
      : {}),
    ...(textGeneratorsPatch !== undefined
      ? { textGenerators: mergeSettingsEntries(current.textGenerators, textGeneratorsPatch) }
      : {}),
    ...(easDeviceHostsPatch === undefined
      ? {}
      : {
          easDeviceHosts: easDeviceHostsPatch.map((host) => {
            const previous = current.easDeviceHosts.find((candidate) => candidate.id === host.id);
            return host.accessTokenReference === undefined &&
              (host.accessToken === "" || host.accessToken === "••••••") &&
              previous?.accessTokenReference != null
              ? { ...host, accessTokenReference: previous.accessTokenReference }
              : host;
          }),
        }),
    ...(secretProvidersPatch !== undefined
      ? { secretProviders: mergeSettingsEntries(current.secretProviders, secretProvidersPatch) }
      : {}),
    ...(completionWebhookPatch !== undefined
      ? {
          completionWebhook: mergeCompletionWebhook(
            current.completionWebhook,
            completionWebhookPatch,
          ),
        }
      : {}),
    ...(usagePriceOverridesPatch !== undefined
      ? {
          usagePriceOverrides: mergeSettingsEntries(
            current.usagePriceOverrides,
            usagePriceOverridesPatch,
          ),
        }
      : {}),
    ...(usageModelAliasesPatch !== undefined
      ? {
          usageModelAliases: mergeSettingsEntries(
            current.usageModelAliases,
            usageModelAliasesPatch,
          ),
        }
      : {}),
    ...(usageModelFilterPatch !== undefined ? { usageModelFilter: usageModelFilterPatch } : {}),
    ...(patch.sourceControlWriterModelSelection !== undefined
      ? { sourceControlWriterModelSelection: patch.sourceControlWriterModelSelection }
      : {}),
    ...(patch.reviewGuideModelSelection !== undefined
      ? { reviewGuideModelSelection: patch.reviewGuideModelSelection }
      : {}),
    ...(patch.memoryModelSelection !== undefined
      ? { memoryModelSelection: patch.memoryModelSelection }
      : {}),
    ...(patch.goatBotSessionRouting !== undefined
      ? { goatBotSessionRouting: patch.goatBotSessionRouting }
      : {}),
    ...(patch.goatBotModelSelection !== undefined
      ? { goatBotModelSelection: patch.goatBotModelSelection }
      : {}),
    ...(goatBotHomePatch !== undefined &&
    goatBotHomeClaimSupersedes(goatBotHomePatch, current.goatBotHome)
      ? { goatBotHome: goatBotHomePatch }
      : {}),
    ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
    ...(providerHealthRefreshInterval !== undefined ? { providerHealthRefreshInterval } : {}),
  };
  const normalizedBackgroundActivity = normalizeBackgroundActivitySettings(
    nextWithReplacementsBase.backgroundActivity,
  );
  const resolvedBackgroundActivity = resolveBackgroundActivitySettings(
    normalizedBackgroundActivity,
  );
  const nextWithReplacements = {
    ...withIdleCompaction(nextWithReplacementsBase, patchedIdleCompaction(current, patch)),
    ...deriveLegacyProjectOverrides(nextWithReplacementsBase),
    backgroundActivity: normalizedBackgroundActivity,
    automaticGitFetchInterval: resolvedBackgroundActivity.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolvedBackgroundActivity.providerHealthRefreshInterval,
    backgroundActivityProfile: resolvedBackgroundActivity.profile,
  };
  if (!selectionPatch) {
    return nextWithReplacements;
  }

  const instanceId = selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : mergeModelSelectionOptionsById({
        current: current.textGenerationModelSelection.options,
        patch: selectionPatch.options,
      });

  return {
    ...nextWithReplacements,
    textGenerationModelSelection: createModelSelection(instanceId, model, options),
  };
}

export function resolveModelPreferences(
  settings: Pick<ServerSettings, "favorites" | "providerModelPreferences">,
  legacy: Partial<ModelPreferences> = {},
): ModelPreferences {
  return {
    favorites: settings.favorites ?? legacy.favorites ?? [],
    providerModelPreferences:
      settings.providerModelPreferences ?? legacy.providerModelPreferences ?? {},
  };
}

/** Empty legacy values do not claim ownership before another client can migrate its saved list. */
export function modelPreferencesMigrationPatch(
  settings: Pick<ServerSettings, "favorites" | "providerModelPreferences">,
  legacy: Partial<ModelPreferences>,
): ServerSettingsPatch | null {
  const favorites =
    settings.favorites === null && (legacy.favorites?.length ?? 0) > 0
      ? legacy.favorites
      : undefined;
  const providerModelPreferences =
    settings.providerModelPreferences === null &&
    Object.keys(legacy.providerModelPreferences ?? {}).length > 0
      ? legacy.providerModelPreferences
      : undefined;
  return favorites === undefined && providerModelPreferences === undefined
    ? null
    : {
        migrateModelPreferences: {
          ...(favorites === undefined ? {} : { favorites }),
          ...(providerModelPreferences === undefined ? {} : { providerModelPreferences }),
        },
      };
}

/**
 * The model GOAT Bot's own turns run on: the chosen one, else the new-thread default, else the
 * text generation model. The server falls back to the latter two when the chosen model is not
 * offered on that machine.
 */
export function resolveGoatBotModelSelection(settings: ServerSettings): ModelSelection {
  return (
    settings.goatBotModelSelection ??
    settings.defaultModelSelection ??
    settings.textGenerationModelSelection
  );
}

export { sourceControlTokenPatch } from "./sourceControlHostSettings.ts";
