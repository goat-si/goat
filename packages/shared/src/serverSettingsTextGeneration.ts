import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  isProviderAvailable,
  isUnconfiguredDefaultInstanceEnabled,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  isProviderTextGenerationCapable,
  isModelTextGenerationCapable,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ProjectId,
  type ServerSettings,
} from "@goat/contracts";
import {
  codexModelFamily,
  normalizeModelSlug,
  readCustomModelEntries,
  resolveSelectableModel,
} from "./model.ts";
import { isTextGenerationFallbackCandidate } from "./textGenerationFallback.ts";

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

function configuredTextGenerationDefault(driver: ProviderDriverKind): string {
  return (
    DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[driver] ??
    DEFAULT_MODEL_BY_PROVIDER[driver] ??
    DEFAULT_TEXT_GENERATION_MODEL
  );
}

/** Configured instances come after every default instance, so they only win when no default qualifies. */
export function fallbackTextGenerationModelSelection(
  providerInstances: ServerSettings["providerInstances"],
  isEnabled: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => boolean,
  options?: { readonly defaultModelSelection?: ModelSelection | null },
): ModelSelection | null {
  const candidates = [
    ...TEXT_GENERATION_FALLBACK_DRIVERS.map(
      (driver) => [defaultInstanceIdForDriver(driver), driver] as const,
    ),
    ...Object.entries(providerInstances).flatMap(([instanceId, instance]) =>
      TEXT_GENERATION_FALLBACK_DRIVERS.includes(instance.driver)
        ? [[ProviderInstanceId.make(instanceId), instance.driver] as const]
        : [],
    ),
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
  return { instanceId, model: configuredTextGenerationDefault(driver) };
}

function matchTextGenerationModel(
  driver: ProviderDriverKind,
  requested: string | undefined,
  models: ReadonlyArray<ServerProviderModel>,
): string | null {
  const model = resolveSelectableModel(driver, requested, models);
  if (model !== null || driver !== "codex") return model;
  const normalized = normalizeModelSlug(requested, driver);
  if (normalized === null) return null;
  const family = codexModelFamily(normalized);
  return models.find((candidate) => codexModelFamily(candidate.slug) === family)?.slug ?? null;
}

function textGenerationCatalogDefault(
  driver: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
): string | undefined {
  const capable = models.filter(
    (model) => !model.isCustom && model.supportsTextGeneration !== false,
  );
  const preferred = DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[driver];
  return (
    matchTextGenerationModel(driver, preferred, capable) ??
    (
      capable.find((model) => model.isDefault === true) ??
      (driver === "codex" ? capable.find((model) => !model.isLegacy) : undefined) ??
      capable[0]
    )?.slug
  );
}

export function textGenerationDefaultModel(snapshot: ServerProvider): string {
  return (
    textGenerationCatalogDefault(snapshot.driver, snapshot.models) ??
    configuredTextGenerationDefault(snapshot.driver)
  );
}

export function resolveTextGenerationModelSelection(
  selection: ModelSelection,
  driver: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  customModels: unknown,
): {
  readonly selection: ModelSelection;
  readonly reason: "saved" | "model_unsupported";
} {
  const requested = selection.model;
  // Snapshots can still carry a custom model after its settings entry is removed.
  const builtIn = models.filter((model) => !model.isCustom);
  const matched =
    builtIn.find((model) => model.slug === requested)?.slug ??
    readCustomModelEntries(customModels).find((model) => model.slug === requested)?.slug ??
    matchTextGenerationModel(driver, requested, builtIn);
  const listed = models.find((model) => model.slug === (matched ?? requested));
  if (matched !== null && listed?.supportsTextGeneration !== false) {
    return {
      selection: matched === requested ? selection : { ...selection, model: matched },
      reason: "saved",
    };
  }

  const fallback = textGenerationCatalogDefault(driver, builtIn);
  // A runtime may dispatch a saved model before discovery fills its catalog.
  if (fallback === undefined && listed?.supportsTextGeneration !== false) {
    return { selection, reason: "saved" };
  }
  return {
    selection: {
      instanceId: selection.instanceId,
      model: fallback ?? configuredTextGenerationDefault(driver),
    },
    reason: "model_unsupported",
  };
}

function resolveSnapshotModel(
  settings: ServerSettings,
  selection: ModelSelection,
  provider: ServerProvider,
) {
  const config = settings.providerInstances[selection.instanceId]?.config as
    | { customModels?: unknown }
    | undefined;
  return resolveTextGenerationModelSelection(
    selection,
    provider.driver,
    provider.models,
    config?.customModels,
  );
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
    isProviderTextGenerationCapable(provider) &&
    isModelTextGenerationCapable(provider, selection.model)
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
  now?: number,
): ModelSelection {
  const selection = resolveSourceControlWriterModelSelection(
    { ...settings, sourceControlWriterModelSelection: settings.memoryModelSelection },
    providers,
    null,
  );
  return agentOnlySelection(settings, providers, null, selection, false, now);
}

/**
 * The provider text generation falls back to, in the fallback driver order. Settings and the
 * server both resolve through it, so Settings names the provider the server runs.
 */
export function resolveTextGenerationFallback(
  settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">,
  providers: ReadonlyArray<ServerProvider> | undefined,
  options: {
    readonly projectId: ProjectId | null;
    readonly excludeInstanceId: ProviderInstanceId;
    readonly now?: number | undefined;
    readonly accept?: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => boolean;
  },
): ModelSelection | null {
  const fallback = fallbackTextGenerationModelSelection(
    settings.providerInstances,
    (id, driver) => {
      if (id === options.excludeInstanceId || options.accept?.(id, driver) === false) return false;
      if (providers === undefined) {
        return resolveProjectProviderInstanceEnabled(settings, options.projectId, id);
      }
      const provider = providers.find((candidate) => candidate.instanceId === id);
      return (
        provider !== undefined &&
        isTextGenerationFallbackCandidate(provider, textGenerationDefaultModel(provider), {
          settings,
          projectId: options.projectId,
          now: options.now,
        })
      );
    },
  );
  const snapshot = providers?.find((provider) => provider.instanceId === fallback?.instanceId);
  return snapshot === undefined
    ? fallback
    : { instanceId: snapshot.instanceId, model: textGenerationDefaultModel(snapshot) };
}

export function resolveTextGenerationRoute(
  settings: ServerSettings,
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
  projectId: ProjectId | null,
  now: number,
): {
  readonly selection: ModelSelection;
  readonly reason: "saved" | "model_unsupported" | "provider_unsupported" | "no_fallback";
} {
  if (textGenerator(settings, selection.instanceId)?.enabled === true) {
    return { selection, reason: "saved" };
  }
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const ownDefault = () =>
    provider === undefined
      ? selection
      : { instanceId: selection.instanceId, model: textGenerationDefaultModel(provider) };
  if (
    provider?.enabled === true &&
    isProviderAvailable(provider) &&
    isProviderTextGenerationCapable(provider) &&
    (projectId === null ||
      resolveProjectProviderInstanceEnabled(settings, projectId, provider.instanceId))
  ) {
    return resolveSnapshotModel(settings, selection, provider);
  }
  const fallback = resolveTextGenerationFallback(settings, providers, {
    projectId,
    excludeInstanceId: selection.instanceId,
    now,
    accept: (id) => textGenerator(settings, id) === undefined,
  });
  return fallback === null
    ? { selection: ownDefault(), reason: "no_fallback" }
    : { selection: fallback, reason: "provider_unsupported" };
}

function agentOnlySelection(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | undefined,
  projectId: ProjectId | null,
  selection: ModelSelection,
  investigate: boolean,
  now: number | undefined,
): ModelSelection {
  const instanceId = selection?.instanceId;
  if (instanceId === undefined || textGenerator(settings, instanceId) === undefined)
    return selection;
  return (
    resolveTextGenerationFallback(settings, providers, {
      projectId,
      excludeInstanceId: instanceId,
      now,
      // Review guides investigate the checkout read-only; the other drivers reject that request.
      accept: (id, driver) =>
        textGenerator(settings, id) === undefined &&
        (!investigate || driver === "codex" || driver === "claudeAgent"),
    }) ?? selection
  );
}

export function resolveReviewGuideModelSelection(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | undefined,
  projectId: ProjectId | null,
  now?: number,
): ModelSelection {
  const selection = settings.reviewGuideModelSelection;
  if (
    selection &&
    textGenerator(settings, selection.instanceId) === undefined &&
    resolveProjectProviderInstanceEnabled(settings, projectId, selection.instanceId)
  ) {
    const provider = providers?.find((candidate) => candidate.instanceId === selection.instanceId);
    if (providers === undefined) return selection;
    if (
      provider?.enabled === true &&
      isProviderAvailable(provider) &&
      isProviderTextGenerationCapable(provider) &&
      isModelTextGenerationCapable(provider, selection.model)
    ) {
      return resolveSnapshotModel(settings, selection, provider).selection;
    }
  }
  const inherited = agentOnlySelection(
    settings,
    providers,
    projectId,
    resolveSourceControlWriterModelSelection(settings, providers, projectId),
    true,
    now,
  );
  const provider = providers?.find((candidate) => candidate.instanceId === inherited.instanceId);
  return provider === undefined
    ? inherited
    : resolveSnapshotModel(settings, inherited, provider).selection;
}
