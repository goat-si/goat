import {
  ANTIGRAVITY_DEFAULT_MODEL,
  defaultInstanceIdForDriver,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@goat/contracts";
import { createModelSelection, readCustomModelEntries } from "@goat/shared/model";
import { resolveGoatBotModelSelection } from "@goat/shared/serverSettings";

import { resolveProviderInstanceDisplayName } from "../state/providerInstanceDisplay.ts";

const MAX_CUSTOM_MODEL_LENGTH = 256;

export interface GoatBotModelEntryInput {
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly isAvailable: boolean;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly isDefault?: boolean | undefined;
  }>;
}

export interface GoatBotModelChoice {
  readonly key: string;
  readonly instanceId: ProviderInstanceId;
  readonly providerLabel: string;
  readonly driverKind: ProviderDriverKind;
  readonly model: string;
  readonly label: string;
  readonly isDefault: boolean;
  readonly isCustom: boolean;
  readonly isLegacy: boolean;
  readonly selection: ModelSelection;
}

interface GoatBotResolvedModel {
  readonly slug: string;
  readonly name: string;
  readonly isCustom: boolean;
  readonly isDefault?: boolean | undefined;
  readonly isLegacy?: boolean | undefined;
}

function resolveInstanceModels(
  settings: Pick<ServerSettings, "providerInstances" | "providerModelPreferences">,
  entry: {
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: ProviderDriverKind;
    readonly models: ServerProvider["models"];
  },
): ReadonlyArray<GoatBotResolvedModel> {
  // Server-reported custom rows mirror settings and can lag a removal, so built-in
  // rows come from the snapshot while custom rows are rebuilt from settings.
  const models: GoatBotResolvedModel[] = entry.models
    .filter((model) => !model.isCustom)
    .map((model) => ({
      slug: model.slug,
      name: model.name,
      isCustom: false,
      ...(model.isDefault ? { isDefault: true } : {}),
      ...(model.isLegacy ? { isLegacy: true } : {}),
    }));
  const seen = new Set(models.map((model) => model.slug));
  const builtInSlugs = new Set(seen);

  if (entry.driverKind !== "antigravity") {
    const config = settings.providerInstances?.[entry.instanceId]?.config;
    const rawCustomModels =
      config !== null && typeof config === "object"
        ? (config as Record<string, unknown>).customModels
        : undefined;
    if (Array.isArray(rawCustomModels)) {
      for (const custom of readCustomModelEntries(rawCustomModels)) {
        if (
          custom.slug.length > MAX_CUSTOM_MODEL_LENGTH ||
          builtInSlugs.has(custom.slug) ||
          seen.has(custom.slug)
        ) {
          continue;
        }
        seen.add(custom.slug);
        models.push({ slug: custom.slug, name: custom.name, isCustom: true });
      }
    }
  }

  const preferences = settings.providerModelPreferences?.[entry.instanceId];
  const hiddenModels = new Set(preferences?.hiddenModels ?? []);
  const order = new Map((preferences?.modelOrder ?? []).map((slug, index) => [slug, index]));
  const visible = models.filter(
    (model) =>
      (entry.driverKind !== "antigravity" || model.slug !== ANTIGRAVITY_DEFAULT_MODEL) &&
      (model.isCustom || !hiddenModels.has(model.slug)),
  );
  if (order.size > 0) {
    visible.sort((a, b) => (order.get(a.slug) ?? Infinity) - (order.get(b.slug) ?? Infinity));
  }
  return visible;
}

export function deriveGoatBotModelState<TEntry extends GoatBotModelEntryInput>({
  settings,
  entries,
}: {
  readonly settings: ServerSettings;
  readonly entries: ReadonlyArray<TEntry>;
}) {
  const selection = resolveGoatBotModelSelection(settings);
  const activeEntry = entries.find((entry) => entry.instanceId === selection.instanceId);
  // When the automatic model's provider is gone, choosing a model starts from one that exists.
  const startEntry =
    activeEntry ??
    entries.find((entry) => entry.enabled && entry.isAvailable && entry.models.length > 0);
  const startModel = startEntry?.models.find((model) => model.isDefault) ?? startEntry?.models[0];
  const separate = settings.goatBotModelSelection !== null;
  const initialSelection = activeEntry
    ? createModelSelection(selection.instanceId, selection.model, selection.options)
    : startEntry && startModel
      ? createModelSelection(startEntry.instanceId, startModel.slug)
      : null;
  const automaticDescription = `${selection.model}${activeEntry ? "" : " (not available)"}`;
  return {
    selection,
    separate,
    activeEntry,
    startEntry,
    startModel,
    initialSelection,
    automaticDescription,
    automaticLabel: `Automatic · ${automaticDescription}`,
  };
}

export function deriveGoatBotModelSettings({
  settings,
  providers,
}: {
  readonly settings: ServerSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const byKind = new Map<
    ProviderDriverKind,
    Array<{
      readonly instanceId: ProviderInstanceId;
      readonly driverKind: ProviderDriverKind;
      readonly displayName: string;
      readonly enabled: boolean;
      readonly status: ServerProvider["status"];
      readonly isDefault: boolean;
      readonly isAvailable: boolean;
      readonly models: ReadonlyArray<GoatBotResolvedModel>;
    }>
  >();
  for (const snapshot of providers) {
    const entry = {
      instanceId: snapshot.instanceId,
      driverKind: snapshot.driver,
      displayName: resolveProviderInstanceDisplayName(snapshot),
      enabled: resolveProjectProviderInstanceEnabled(settings, null, snapshot.instanceId),
      status: snapshot.status,
      isDefault: snapshot.instanceId === defaultInstanceIdForDriver(snapshot.driver),
      isAvailable: snapshot.availability !== "unavailable",
      models: resolveInstanceModels(settings, {
        instanceId: snapshot.instanceId,
        driverKind: snapshot.driver,
        models: snapshot.models,
      }),
    };
    const bucket = byKind.get(entry.driverKind);
    if (bucket) {
      bucket.push(entry);
    } else {
      byKind.set(entry.driverKind, [entry]);
    }
  }

  const entries = [...byKind.values()].flatMap((bucket) => [
    ...bucket.filter((entry) => entry.isDefault),
    ...bucket.filter((entry) => !entry.isDefault),
  ]);
  const state = deriveGoatBotModelState({ settings, entries });
  const choices: GoatBotModelChoice[] = [];
  for (const entry of entries) {
    if (!entry.enabled || !entry.isAvailable || entry.status !== "ready") continue;
    for (const model of entry.models) {
      choices.push({
        key: `${entry.instanceId}:${model.slug}`,
        instanceId: entry.instanceId,
        providerLabel: entry.displayName,
        driverKind: entry.driverKind,
        model: model.slug,
        label: model.name,
        isDefault: model.isDefault === true,
        isCustom: model.isCustom,
        isLegacy: model.isLegacy === true,
        selection: createModelSelection(entry.instanceId, model.slug),
      });
    }
  }

  const selectedChoice = choices.find(
    (choice) =>
      choice.instanceId === state.selection.instanceId && choice.model === state.selection.model,
  );
  const activeModelName =
    state.activeEntry?.models.find((model) => model.slug === state.selection.model)?.name ??
    state.selection.model;
  const summaryLabel = !state.separate
    ? state.automaticLabel
    : selectedChoice
      ? `${selectedChoice.providerLabel} · ${selectedChoice.label}`
      : // A disabled, failed or removed model is not offered, so say so rather than look chosen.
        `${state.activeEntry ? `${state.activeEntry.displayName} · ${activeModelName}` : state.selection.model} (not available)`;

  return {
    ...state,
    entries,
    choices,
    summaryLabel,
  };
}
