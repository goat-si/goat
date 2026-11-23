import { assert, it } from "@effect/vitest";
import type * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { retainPiDiscovery } from "./retainPiDiscovery.ts";

it.effect("retains port discovery until the Pi process exits", () =>
  Effect.gen(function* () {
    let retained = 0;
    const released = yield* Deferred.make<void>();
    const exited = yield* Deferred.make<number>();
    const scope = yield* Scope.make();
    const host = {
      retainAgentPortDiscovery: Effect.acquireRelease(
        Effect.sync(() => {
          retained++;
        }),
        () =>
          Effect.sync(() => {
            retained--;
          }).pipe(Effect.andThen(Deferred.succeed(released, undefined))),
      ),
    } as unknown as ProviderHost.ProviderHost["Service"];
    yield* retainPiDiscovery(host, Deferred.await(exited), scope);
    assert.equal(retained, 1);
    yield* Deferred.succeed(exited, 0);
    yield* Deferred.await(released);
    assert.equal(retained, 0);
    yield* Scope.close(scope, Exit.void);
  }),
);
