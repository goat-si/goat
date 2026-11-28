import type { CustomModelSetting } from "@goat/contracts";
import type { ServerProvider } from "@goat/contracts";
import * as Equal from "effect/Equal";
import type { AcpRegistryLiveConfiguration } from "./probe.ts";

// Cache only successful authenticated probes so sign-in changes remain visible.
export const PROBE_SUCCESS_TTL_MS = 15 * 60 * 1_000;
const PROBE_PROVISIONAL_TTL_MS = 30 * 1_000;

export function acpRegistryProbeTtlMs(provider: ServerProvider): number {
  const discoveredModels = provider.models.filter((model) => !model.isCustom);
  return discoveredModels.length <= 1 ? PROBE_PROVISIONAL_TTL_MS : PROBE_SUCCESS_TTL_MS;
}

export interface AcpRegistryEnrichmentCache {
  readonly generation: number;
  readonly entry: {
    readonly provider: ServerProvider;
    readonly launchIdentity?: string;
    readonly expiresAt: number;
    readonly environmentKey?: string;
  } | null;
}

export function isAcpRegistryCacheValid(
  entry: NonNullable<AcpRegistryEnrichmentCache["entry"]>,
  inspectedVersion: string | null,
  local: boolean,
  now: number,
  inspectedLaunchIdentity?: string,
): boolean {
  return (
    entry.expiresAt > now &&
    ((local && inspectedVersion === null) || entry.provider.version === inspectedVersion) &&
    (inspectedLaunchIdentity === undefined || entry.launchIdentity === inspectedLaunchIdentity)
  );
}

export function updateAcpRegistryEnrichmentCache(
  input: {
    readonly cache: AcpRegistryEnrichmentCache;
    readonly configuration: AcpRegistryLiveConfiguration;
    readonly customModels: ReadonlyArray<CustomModelSetting>;
    readonly now: number;
    readonly environmentKey?: string;
  },
  merge: (
    provider: ServerProvider,
    configuration: AcpRegistryLiveConfiguration,
    customModels: ReadonlyArray<CustomModelSetting>,
  ) => ServerProvider,
): AcpRegistryEnrichmentCache {
  const { cache, configuration, customModels, now } = input;
  if (
    cache.entry !== null &&
    input.environmentKey !== undefined &&
    cache.entry.environmentKey !== input.environmentKey
  ) {
    return { generation: cache.generation + 1, entry: null };
  }
  if (cache.entry === null) {
    // Only a live catalog update advances the epoch; options-only updates must not discard an in-flight probe.
    return configuration.models.length > 0 ? { ...cache, generation: cache.generation + 1 } : cache;
  }
  const provider = merge(cache.entry.provider, configuration, customModels);
  if (Equal.equals(provider, cache.entry.provider)) return cache;
  const catalogChanged = !Equal.equals(
    cache.entry.provider.models.filter((model) => !model.isCustom).map((model) => model.slug),
    provider.models.filter((model) => !model.isCustom).map((model) => model.slug),
  );
  return {
    ...cache,
    // Advance the epoch and renew TTL only when the live session actually changed the model catalog.
    generation: catalogChanged ? cache.generation + 1 : cache.generation,
    entry: {
      ...cache.entry,
      provider,
      expiresAt: catalogChanged ? now + acpRegistryProbeTtlMs(provider) : cache.entry.expiresAt,
    },
  };
}
