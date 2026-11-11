import type { ProviderLatestVersions } from "@goat/provider-core/server/ProviderLatestVersions";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type { ModelManifest, ModelManifestData } from "./ModelManifest.ts";

export const makeModelCatalogRefresh = Effect.fn("ModelCatalogRefresh.make")(function* (
  manifest: ModelManifest["Service"],
  versions: ProviderLatestVersions["Service"],
  initial: ModelManifestData,
) {
  const probed = yield* Ref.make(initial.updatedAt);
  const gate = yield* Semaphore.make(1);
  return {
    capture: <A, E, R>(probe: Effect.Effect<A, E, R>) =>
      manifest.current.pipe(
        Effect.flatMap(({ updatedAt }) => probe.pipe(Effect.tap(() => Ref.set(probed, updatedAt)))),
      ),
    check: (refreshAll: Effect.Effect<unknown>) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const { updatedAt } = yield* manifest.refreshOnDemand;
          if ((yield* Ref.get(probed)) === updatedAt) return;
          yield* versions.invalidateAll;
          for (let pass = 0; pass < 2; pass++) {
            if ((yield* Ref.get(probed)) === updatedAt) return;
            yield* refreshAll;
          }
        }),
      ),
  };
});
