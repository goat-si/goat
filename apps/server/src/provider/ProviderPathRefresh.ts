import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HostPathChanged } from "./hostPathChanged.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

/**
 * Re-reads every provider's status when the PATH changes, so a CLI found by a later login-shell
 * probe shows as installed without waiting for the periodic health check.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const changed = yield* HostPathChanged;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    yield* changed.await.pipe(
      Effect.andThen(changed.close),
      Effect.andThen(providers.refresh()),
      Effect.ignoreCause({ log: true }),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
