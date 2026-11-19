import type { ServerProvider } from "@goat/contracts";
import * as Equal from "effect/Equal";
import type { AcpRegistryLiveConfiguration } from "./probe.ts";

// Cache only successful authenticated probes so sign-in changes remain visible.
const PROBE_SUCCESS_TTL_MS = 15 * 60 * 1_000;
const PROBE_PROVISIONAL_TTL_MS = 30 * 1_000;

export function acpRegistryProbeTtlMs(provider: ServerProvider): number {
  const discoveredModels = provider.models.filter((model) => !model.isCustom);
  return discoveredModels.length <= 1 ? PROBE_PROVISIONAL_TTL_MS : PROBE_SUCCESS_TTL_MS;
}

interface AcpRegistryEnrichmentCache {
  readonly generation: number;
  readonly entry: {
    readonly provider: ServerProvider;
    readonly expiresAt: number;
    readonly environmentKey?: string;
  } | null;
}

export function updateAcpRegistryEnrichmentCache(
  input: {
    readonly cache: AcpRegistryEnrichmentCache;
    readonly configuration: AcpRegistryLiveConfiguration;
    readonly customModels: ReadonlyArray<string>;
    readonly now: number;
    readonly environmentKey?: string;
  },
  merge: (
    provider: ServerProvider,
    configuration: AcpRegistryLiveConfiguration,
    customModels: ReadonlyArray<string>,
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
    // No probe has landed yet, but the live session published its
    // configuration to the snapshot. Advance the cache epoch so a probe that
    // was still in flight cannot overwrite that newer state when it lands.
    return { ...cache, generation: cache.generation + 1 };
  }
  const provider = merge(cache.entry.provider, configuration, customModels);
  if (Equal.equals(provider, cache.entry.provider)) return cache;
  return {
    ...cache,
    // The live session advanced the provider past what an in-flight probe
    // started from; bump the epoch so the probe discards its stale result
    // instead of overwriting this entry and publishing it.
    generation: cache.generation + 1,
    entry: {
      ...cache.entry,
      provider,
      expiresAt: now + acpRegistryProbeTtlMs(provider),
    },
  };
}
