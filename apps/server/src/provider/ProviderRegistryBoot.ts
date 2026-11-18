import type { ProviderInstanceId, ServerProvider } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import type { ProviderSnapshotSource } from "./builtInProviderCatalog.ts";
import {
  hydrateCachedProvider,
  isCachedProviderCorrelated,
  orderProviderSnapshots,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
} from "./providerStatusCache.ts";

export const loadBootProviderSnapshots = Effect.fn("ProviderRegistry.loadBootProviderSnapshots")(
  function* (input: {
    readonly bootInstances: ReadonlyArray<ProviderInstance>;
    readonly bootSources: ReadonlyArray<ProviderSnapshotSource>;
    readonly fallbackProviders: ReadonlyArray<ServerProvider>;
    readonly cacheDir: Parameters<typeof resolveProviderStatusCachePath>[0]["cacheDir"];
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) {
    const fallbackByInstance = new Map<ProviderInstanceId, ServerProvider>();
    for (let index = 0; index < input.fallbackProviders.length; index++) {
      const provider = input.fallbackProviders[index];
      const source = input.bootSources[index];
      if (provider === undefined || source === undefined) {
        continue;
      }
      fallbackByInstance.set(source.instanceId, provider);
    }
    // Read after the snapshots: a snapshot read as awaiting is the pre-check placeholder.
    const awaitingBootInstances = new Set<ProviderInstance>();
    for (const instance of input.bootInstances) {
      if (yield* instance.snapshot.isAwaitingFirstCheck ?? Effect.succeed(false)) {
        awaitingBootInstances.add(instance);
      }
    }

    const bootProviders = yield* Effect.forEach(
      input.bootSources,
      (source, index) =>
        Effect.gen(function* () {
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: input.cacheDir,
            instanceId: source.instanceId,
          }).pipe(Effect.provideService(Path.Path, input.path));
          const fallbackProvider = fallbackByInstance.get(source.instanceId);
          if (fallbackProvider === undefined) {
            return undefined;
          }
          // A completed check is seeded by the boot upsert instead, which persists it.
          const instance = input.bootInstances[index];
          const placeholder =
            instance !== undefined && awaitingBootInstances.has(instance)
              ? fallbackProvider
              : undefined;
          return yield* readProviderStatusCache(filePath).pipe(
            Effect.provideService(FileSystem.FileSystem, input.fileSystem),
            Effect.flatMap((cachedProvider) => {
              if (cachedProvider === undefined) {
                return Effect.succeed(placeholder);
              }
              const correlation = {
                cachedProvider,
                fallbackProvider,
              } as const;
              if (!isCachedProviderCorrelated(correlation)) {
                return Effect.logWarning("provider status cache identity mismatch, ignoring", {
                  path: filePath,
                  instanceId: source.instanceId,
                  cachedInstanceId: cachedProvider.instanceId ?? null,
                  driver: source.driverKind,
                  cachedDriver: cachedProvider.driver ?? null,
                }).pipe(Effect.as(placeholder));
              }
              return Effect.succeed(hydrateCachedProvider(correlation));
            }),
          );
        }),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((providers) =>
        orderProviderSnapshots(
          providers.filter((provider): provider is ServerProvider => provider !== undefined),
        ),
      ),
    );
    return { bootProviders, awaitingBootInstances };
  },
);
