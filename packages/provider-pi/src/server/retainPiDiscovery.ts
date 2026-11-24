import type * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { PiRpcError } from "./rpc.ts";

export const retainPiDiscovery = Effect.fn("Pi.retainPortDiscovery")(function* (
  host: ProviderHost.ProviderHost["Service"],
  exited: Effect.Effect<number, PiRpcError>,
  scope: Scope.Scope,
) {
  if (host.retainAgentPortDiscovery === undefined) return;
  const retainScope = yield* Scope.fork(scope, "sequential");
  yield* host.retainAgentPortDiscovery.pipe(Effect.provideService(Scope.Scope, retainScope));
  yield* exited.pipe(
    Effect.exit,
    Effect.andThen(Scope.close(retainScope, Exit.void)),
    Effect.forkIn(scope),
  );
});
