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
  type ProjectId,
  type ServerSettings,
} from "@goat/contracts";
import { readCustomModelEntries } from "./model.ts";
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
  return {
    instanceId,
    model:
      DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[driver] ??
      DEFAULT_MODEL_BY_PROVIDER[driver] ??
      DEFAULT_TEXT_GENERATION_MODEL,
  };
}

/**
 * The model text generation runs on an instance when its saved model cannot be used, as the
 * Settings picker resolves it: the driver's text generation default, else the status's default
 * or first model that can generate text (Pi and OmO list "default" first).
 */
export function textGenerationDefaultModel(snapshot: ServerProvider): string {
  const capable = snapshot.models.filter((model) => model.supportsTextGeneration !== false);
  const preferred = DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[snapshot.driver];
  return (
    capable.find((model) => model.slug === preferred)?.slug ??
    (capable.find((model) => model.isDefault === true) ?? capable[0])?.slug ??
    preferred ??
    DEFAULT_MODEL_BY_PROVIDER[snapshot.driver] ??
    DEFAULT_TEXT_GENERATION_MODEL
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
    return isModelTextGenerationCapable(provider, selection.model)
      ? { selection, reason: "saved" }
      : { selection: ownDefault(), reason: "model_unsupported" };
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
    if (
      providers === undefined ||
      (provider?.enabled === true &&
        isProviderAvailable(provider) &&
        isProviderTextGenerationCapable(provider) &&
        isModelTextGenerationCapable(provider, selection.model))
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
    now,
  );
}
