import {
  ProviderOptionDescriptor,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
} from "@goat/contracts";
import { writeFileStringAtomically } from "@goat/shared/atomicWrite";
import { createModelCapabilities } from "@goat/shared/model";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { AcpRegistrySettings } from "../settings.ts";
import type { AcpRegistryLiveConfiguration } from "./probe.ts";

/** The options an ACP agent reports for one model only (thought_level, model_config), by model. */
export type AcpRegistryLearnedModelOptions = ReadonlyMap<
  string,
  ReadonlyArray<ProviderOptionDescriptor>
>;

const EMPTY_OPTIONS: AcpRegistryLearnedModelOptions = new Map();

const decodeStored = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      binding: Schema.String,
      version: Schema.NullOr(Schema.String),
      environments: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Record(Schema.String, Schema.Array(ProviderOptionDescriptor)),
        ),
      ),
      models: Schema.optional(Schema.Record(Schema.String, Schema.Array(ProviderOptionDescriptor))),
    }),
  ),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const hash = Effect.fn("AcpRegistryLearnedModelOptions.hash")(function* (value: unknown) {
  const crypto = yield* Digest.Digest;
  const json = yield* encodeJson(value).pipe(Effect.orDie);
  const digest = yield* crypto
    .digest(Digest.sha256, new TextEncoder().encode(json))
    .pipe(Effect.orDie);
  return Hex.encode(digest);
});

type EnvironmentModels = ReadonlyMap<string, AcpRegistryLearnedModelOptions>;

interface LearnedState {
  readonly version: string | null;
  readonly environments: EnvironmentModels;
  readonly saved:
    | { readonly version: string | null; readonly environments: EnvironmentModels }
    | undefined;
}

function mergeEnvironmentMaps(
  stored: EnvironmentModels,
  learnedThisRun: EnvironmentModels,
): EnvironmentModels {
  const merged = new Map<string, AcpRegistryLearnedModelOptions>();
  for (const [envKey, models] of stored) {
    merged.set(envKey, new Map(models));
  }
  for (const [envKey, models] of learnedThisRun) {
    const existing = merged.get(envKey) ?? EMPTY_OPTIONS;
    merged.set(envKey, new Map([...existing, ...models]));
  }
  return merged;
}

/**
 * Per-model options kept on disk, trusted only for the agent version they were read from
 * and scoped to the session environment they were observed under.
 * Live sessions replace an entry; discovery only fills models nothing has reported yet.
 */
export const makeAcpRegistryLearnedModelOptionsStore = Effect.fn(
  "makeAcpRegistryLearnedModelOptionsStore",
)(function* (input: {
  readonly cacheDir: string;
  readonly instanceId: ProviderInstanceId;
  readonly settings: AcpRegistrySettings;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(
    input.cacheDir,
    `acp-model-options-${yield* hash(input.instanceId)}.json`,
  );
  const binding = yield* hash({
    source: input.settings.source,
    agentId: input.settings.agentId,
    commandPath: input.settings.commandPath,
    commandArgs: input.settings.commandArgs,
    distribution: input.settings.distribution,
  });
  const saved = yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(decodeStored),
    Effect.orElseSucceed(() => undefined),
  );
  const savedEnvironments: EnvironmentModels | undefined =
    saved?.binding === binding
      ? saved.environments !== undefined
        ? new Map(
            Object.entries(saved.environments).map(([envKey, models]) => [
              envKey,
              new Map(Object.entries(models)),
            ]),
          )
        : saved.models !== undefined
          ? new Map([["", new Map(Object.entries(saved.models))]])
          : new Map()
      : undefined;
  const state = yield* Ref.make<LearnedState>({
    version: null,
    environments: new Map(),
    saved:
      saved !== undefined && savedEnvironments !== undefined
        ? { version: saved.version, environments: savedEnvironments }
        : undefined,
  });
  const lock = yield* Semaphore.make(1);
  const persist = (current: LearnedState) =>
    writeFileStringAtomically({
      filePath,
      contents: JSON.stringify({
        binding,
        version: current.version,
        environments: Object.fromEntries(
          Array.from(current.environments, ([envKey, models]) => [
            envKey,
            Object.fromEntries(models),
          ]),
        ),
      }),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.tapError(() => Effect.logWarning("Could not save ACP model options.")),
      Effect.ignore,
    );
  const update = (next: (current: LearnedState) => LearnedState) =>
    lock.withPermit(
      Ref.modify(state, (current) => {
        const updated = next(current);
        return [updated === current ? undefined : updated, updated] as const;
      }).pipe(
        Effect.flatMap((updated) => (updated === undefined ? Effect.void : persist(updated))),
      ),
    );

  return {
    get: (environmentKey = "") =>
      Ref.get(state).pipe(
        Effect.map((current) => current.environments.get(environmentKey) ?? EMPTY_OPTIONS),
      ),
    setVersion: (version: string | null) =>
      update((current) => {
        if (version === null || version === current.version) return current;
        // Options learned before the version was known came from this same binary.
        const learnedThisRun: EnvironmentModels =
          current.version === null ? current.environments : new Map();
        const stored: EnvironmentModels =
          current.saved?.version === version ? current.saved.environments : new Map();
        return {
          version,
          environments: mergeEnvironmentMaps(stored, learnedThisRun),
          saved: undefined,
        };
      }),
    learn: (
      modelId: string,
      options: ReadonlyArray<ProviderOptionDescriptor>,
      source: "live" | "discovered",
      environmentKey = "",
    ) =>
      update((current) => {
        const existingMap = current.environments.get(environmentKey) ?? EMPTY_OPTIONS;
        const existing = existingMap.get(modelId);
        if (
          existing !== undefined &&
          (source === "discovered" || Equal.equals(existing, options))
        ) {
          return current;
        }
        const nextModels = new Map(existingMap).set(modelId, options);
        return {
          ...current,
          environments: new Map(current.environments).set(environmentKey, nextModels),
        };
      }),
    clear: update((current) => ({ ...current, environments: new Map(), saved: undefined })),
  };
});

/** The model-specific options a session reported for its current model. */
export function acpRegistryCurrentModelOptions(
  configuration: AcpRegistryLiveConfiguration,
):
  | { readonly modelId: string; readonly options: ReadonlyArray<ProviderOptionDescriptor> }
  | undefined {
  // An empty report without a model select is a placeholder, not a statement about the model.
  if (
    configuration.currentModelId === null ||
    (configuration.configOptions.length === 0 && configuration.modelsFromModelSelect !== true)
  ) {
    return undefined;
  }
  const modelOptionIds = new Set(configuration.modelOptionIds ?? []);
  return {
    modelId: configuration.currentModelId,
    options: configuration.configOptions.filter((option) => modelOptionIds.has(option.id)),
  };
}

/** Adds learned options to models that are not the session's own and lack them. */
export function withAcpRegistryLearnedModelOptions(
  provider: ServerProvider,
  learned: AcpRegistryLearnedModelOptions,
): ServerProvider {
  if (learned.size === 0) return provider;
  let changed = false;
  const models = provider.models.map((model): ServerProviderModel => {
    const options = learned.get(model.slug);
    if (model.isCustom || model.isDefault === true || options === undefined) return model;
    const current = model.capabilities?.optionDescriptors ?? [];
    // Levels the model advertises itself (`_meta`) keep their place.
    const missing = options.filter((option) => !current.some(({ id }) => id === option.id));
    if (missing.length === 0) return model;
    changed = true;
    return {
      ...model,
      capabilities: createModelCapabilities({ optionDescriptors: [...current, ...missing] }),
    };
  });
  return changed ? { ...provider, models } : provider;
}

/**
 * Visible models whose options no session has reported yet: favorites first, then the
 * user's model order, then the agent's. Models that advertise their levels are skipped.
 */
export function acpRegistryModelsToDiscover(input: {
  readonly provider: Pick<ServerProvider, "instanceId" | "models">;
  readonly settings: Pick<ServerSettings, "favorites" | "providerModelPreferences">;
  readonly learned: AcpRegistryLearnedModelOptions;
}): ReadonlyArray<string> {
  const { provider, settings, learned } = input;
  const preferences = settings.providerModelPreferences?.[provider.instanceId];
  const hidden = new Set(preferences?.hiddenModels ?? []);
  const rank = (slugs: ReadonlyArray<string>) =>
    new Map(slugs.map((slug, index) => [slug, index] as const));
  const favoriteRank = rank(
    (settings.favorites ?? [])
      .filter((favorite) => favorite.provider === provider.instanceId)
      .map((favorite) => favorite.model),
  );
  const orderRank = rank(preferences?.modelOrder ?? []);
  const catalogRank = rank(provider.models.map((model) => model.slug));
  const ranked = (ranks: ReadonlyMap<string, number>, slug: string) =>
    ranks.get(slug) ?? Number.POSITIVE_INFINITY;
  return provider.models
    .filter(
      (model) =>
        !model.isCustom &&
        model.isDefault !== true &&
        !hidden.has(model.slug) &&
        !learned.has(model.slug) &&
        !(model.capabilities?.optionDescriptors ?? []).some(
          (option) => option.type === "select" && option.role === "reasoning",
        ),
    )
    .map((model) => model.slug)
    .toSorted(
      (a, b) =>
        ranked(favoriteRank, a) - ranked(favoriteRank, b) ||
        ranked(orderRank, a) - ranked(orderRank, b) ||
        ranked(catalogRank, a) - ranked(catalogRank, b),
    );
}
