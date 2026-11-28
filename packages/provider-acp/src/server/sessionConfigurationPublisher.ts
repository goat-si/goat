import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import type { AcpAdapterV2Flavor } from "./adapterFlavor.ts";

export const makeSessionConfigurationPublisher = Effect.fnUntraced(function* (deps: {
  readonly onSessionConfigurationUpdate: AcpAdapterV2Flavor["onSessionConfigurationUpdate"];
  readonly activeSessionSetup: Ref.Ref<AcpSessionRuntime.AcpSessionRuntimeStartResult | null>;
}) {
  const lastPublishedCatalogKey = yield* Ref.make<{
    readonly epoch: number;
    readonly key: string | null;
  }>({ epoch: 0, key: null });
  const publishPermit = yield* Semaphore.make(1);
  const reset = Ref.update(lastPublishedCatalogKey, (current) => ({
    epoch: current.epoch + 1,
    key: null,
  }));
  // Per-update session config publication shares the enclosing session update/config span.
  const publish = Effect.fnUntraced(function* (
    targetRuntime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  ) {
    const onSessionConfigurationUpdate = deps.onSessionConfigurationUpdate;
    if (onSessionConfigurationUpdate === undefined) return;
    yield* publishPermit.withPermit(
      Effect.gen(function* () {
        const { epoch, key } = yield* Ref.get(lastPublishedCatalogKey);
        const configOptions = yield* targetRuntime.getConfigOptions;
        const modeState = yield* targetRuntime.getModeState;
        const modelState = (yield* Ref.get(deps.activeSessionSetup))?.sessionSetupResult.models;
        const nextKey = yield* onSessionConfigurationUpdate(configOptions, modeState, modelState, {
          lastCatalogKey: key,
        });
        if (nextKey === null || typeof nextKey === "string") {
          yield* Ref.update(lastPublishedCatalogKey, (current) =>
            current.epoch === epoch ? { epoch, key: nextKey } : current,
          );
        }
      }),
    );
  });
  return { reset, publish };
});
