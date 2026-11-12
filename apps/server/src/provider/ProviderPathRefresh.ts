import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HostPathChanged } from "./hostPathChanged.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

/**
 * Waits for one PATH change, then runs a provider refresh that starts after it. A refresh
 * already running may have checked a provider against the old PATH, so this waits for it to
 * settle; changes that arrive meanwhile share the one follow-up.
 */
export const refreshOnPathChange = Effect.gen(function* () {
  const changed = yield* HostPathChanged;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const refreshSettled = providers.awaitInFlightRefresh ?? Effect.void;
  yield* changed.await;
  yield* refreshSettled;
  yield* changed.close;
  // A refresh someone else began before the close could still predate the last change.
  yield* refreshSettled;
  yield* providers.refresh();
});

/**
 * Follows PATH changes for the server's lifetime, so a CLI found by a later login-shell probe
 * shows as installed without waiting for the periodic health check.
 */
export const layer = Layer.effectDiscard(
  refreshOnPathChange.pipe(Effect.ignoreCause({ log: true }), Effect.forever, Effect.forkScoped),
);
