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
import { isTextGenerationQuotaExhausted } from "./textGenerationFallback.ts";

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

/** Configured instances come after every default instance. */
function textGenerationFallbackCandidates(providerInstances: ServerSettings["providerInstances"]) {
  return [
    ...TEXT_GENERATION_FALLBACK_DRIVERS.map(
      (driver) => [defaultInstanceIdForDriver(driver), driver] as const,
    ),
    ...Object.entries(providerInstances).flatMap(([instanceId, instance]) =>
      TEXT_GENERATION_FALLBACK_DRIVERS.includes(instance.driver)
        ? [[ProviderInstanceId.make(instanceId), instance.driver] as const]
        : [],
    ),
  ];
}

export function fallbackTextGenerationModelSelection(
  providerInstances: ServerSettings["providerInstances"],
  isEnabled: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => boolean,
  options?: { readonly defaultModelSelection?: ModelSelection | null },
): ModelSelection | null {
  const match = textGenerationFallbackCandidates(providerInstances).find(([instanceId, driver]) =>
    isEnabled(instanceId, driver),
  );
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

export const isReviewGuideDriver = (driver: ProviderDriverKind): boolean =>
  driver === "codex" || driver === "claudeAgent";

type RoutingScope = {
  readonly projectId: ProjectId | null;
  readonly now: number;
  readonly purpose?: "memory" | "reviewGuide";
};

export function isTextGenerationEligible(
  settings: ServerSettings,
  selection: ModelSelection,
  provider: ServerProvider | undefined,
  scope: RoutingScope,
): boolean {
  const generator = textGenerator(settings, selection.instanceId);
  if (generator !== undefined) {
    return (
      scope.purpose === undefined &&
      generator.enabled &&
      settings.projectSettingsOverrides[scope.projectId ?? ""]?.providerInstances?.[
        selection.instanceId
      ]?.enabled !== false
    );
  }
  return (
    provider !== undefined &&
    resolveProjectProviderInstanceEnabled(settings, scope.projectId, selection.instanceId) &&
    provider.enabled &&
    provider.installed &&
    (provider.status === "ready" || provider.status === "warning") &&
    provider.auth.status !== "unauthenticated" &&
    isProviderAvailable(provider) &&
    isProviderTextGenerationCapable(provider) &&
    isModelTextGenerationCapable(provider, selection.model) &&
    !isTextGenerationQuotaExhausted(provider, selection.model, scope.now) &&
    (scope.purpose !== "reviewGuide" || isReviewGuideDriver(provider.driver))
  );
}

function eligiblePrimary(
  settings: ServerSettings,
  selection: ModelSelection | null,
  providers: ReadonlyArray<ServerProvider>,
  scope: RoutingScope,
) {
  if (selection === null) return null;
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const resolved =
    provider === undefined || textGenerator(settings, selection.instanceId) !== undefined
      ? { selection, reason: "saved" as const }
      : resolveSnapshotModel(settings, selection, provider);
  return isTextGenerationEligible(settings, resolved.selection, provider, scope) ? resolved : null;
}

export function resolveTextGenerationFallback(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider>,
  scope: RoutingScope & { readonly excludeInstanceId: ProviderInstanceId },
): ModelSelection | null {
  const candidates = new Map(providers.map((provider) => [provider.instanceId, provider]));
  for (const [instanceId] of textGenerationFallbackCandidates(settings.providerInstances)) {
    const provider = candidates.get(instanceId);
    if (provider === undefined || instanceId === scope.excludeInstanceId) continue;
    const selection = { instanceId, model: textGenerationDefaultModel(provider) };
    if (isTextGenerationEligible(settings, selection, provider, scope)) return selection;
  }
  return null;
}

type TextGenerationRoute =
  | {
      readonly selection: ModelSelection;
      readonly reason: "saved" | "model_unsupported" | "provider_unsupported";
    }
  | { readonly selection: null; readonly reason: "no_fallback" };

export function resolveTextGenerationRoute(
  settings: ServerSettings,
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
  projectId: ProjectId | null,
  now: number,
  purpose?: RoutingScope["purpose"],
): TextGenerationRoute {
  const scope: RoutingScope = { projectId, now, ...(purpose === undefined ? {} : { purpose }) };
  const primary = eligiblePrimary(settings, selection, providers, scope);
  if (primary !== null) return primary;
  const fallback = resolveTextGenerationFallback(settings, providers, {
    ...scope,
    excludeInstanceId: selection.instanceId,
  });
  return fallback === null
    ? { selection: null, reason: "no_fallback" }
    : { selection: fallback, reason: "provider_unsupported" };
}

/** The configured memory choice is also part of the Settings status refresh key. */
export function configuredMemoryModelSelection(settings: ServerSettings): ModelSelection {
  const configured = [settings.memoryModelSelection, settings.textGenerationModelSelection].find(
    (selection) =>
      selection !== null &&
      textGenerator(settings, selection.instanceId) === undefined &&
      isModelSelectionProviderEnabled(settings, selection),
  );
  return (
    configured ??
    fallbackTextGenerationModelSelection(
      settings.providerInstances,
      (instanceId) =>
        textGenerator(settings, instanceId) === undefined &&
        resolveProjectProviderInstanceEnabled(settings, null, instanceId),
    ) ??
    settings.textGenerationModelSelection
  );
}

export function resolveMemoryModelSelection(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider>,
  now: number,
): ModelSelection | null {
  const primary = eligiblePrimary(settings, settings.memoryModelSelection, providers, {
    projectId: null,
    now,
    purpose: "memory",
  });
  return (
    primary?.selection ??
    resolveTextGenerationRoute(
      settings,
      settings.textGenerationModelSelection,
      providers,
      null,
      now,
      "memory",
    ).selection
  );
}

export function resolveReviewGuideModelSelection(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider>,
  projectId: ProjectId | null,
  now: number,
): ModelSelection | null {
  const scope = { projectId, now, purpose: "reviewGuide" } as const;
  const primary = eligiblePrimary(settings, settings.reviewGuideModelSelection, providers, scope);
  if (primary !== null) return primary.selection;
  const writer = settings.sourceControlWriterModelSelection;
  const inherited = eligiblePrimary(settings, writer, providers, scope);
  if (inherited !== null) return inherited.selection;
  return resolveTextGenerationRoute(
    settings,
    writer !== null && textGenerator(settings, writer.instanceId)?.enabled === true
      ? writer
      : settings.textGenerationModelSelection,
    providers,
    projectId,
    now,
    "reviewGuide",
  ).selection;
}
