import { type EnvironmentId, ORCHESTRATION_V2_WS_METHODS } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { PreparedConnection } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";
import { QUERY_ENVIRONMENT, queryConnectionState } from "./runtimeTestSupport.ts";

const decodeNumber = Schema.decodeUnknownEffect(Schema.Number);

describe("finite environment subscription after a stream defect", () => {
  it.effect(
    "surfaces a decode defect from a finite RPC subscription instead of resubscribing",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const firstSubscribed = yield* Deferred.make<void>();
          const resubscribed = yield* Deferred.make<void>();
          const surfaced = yield* Deferred.make<Cause.Cause<unknown>>();
          let subscriptions = 0;
          // Mirrors RpcClient, which decodes each chunk with `Effect.orDie`.
          const decodeDefect = decodeNumber("not a number").pipe(Effect.orDie);
          const client = {
            [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: () => {
              subscriptions += 1;
              Deferred.doneUnsafe(subscriptions === 1 ? firstSubscribed : resubscribed, Exit.void);
              return Stream.fromEffect(decodeDefect).pipe(Stream.drain);
            },
          } as unknown as WsRpcProtocolClient;
          const rpcSession = {
            client,
            initialConfig: Effect.never,
            subscribeServerConfig: () => Stream.never,
            ready: Effect.void,
            probe: Effect.void,
            closed: Effect.never,
          } as unknown as RpcSession.RpcSession;
          const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
            target: QUERY_ENVIRONMENT,
            state: yield* SubscriptionRef.make(queryConnectionState()),
            session: yield* SubscriptionRef.make(Option.some(rpcSession)),
            prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
          const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
            followStream: (_environmentId: EnvironmentId, stream: Stream.Stream<unknown>) =>
              Stream.provideService(
                stream,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
          } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
          // Atoms run their own fibers; share the test clock so a pending retry is driven by it.
          const runtime = Atom.runtime(
            Layer.mergeAll(
              Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
              Layer.succeed(Clock.Clock, yield* Clock.Clock),
            ),
          );
          // Same options as the progressive thread find in orchestration.ts.
          const family = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
            label: "test.finite-rpc-subscription",
            tag: ORCHESTRATION_V2_WS_METHODS.searchThreadStream,
            completeWhen: (result) => result.complete !== false,
            idleTtlMs: 0,
          });
          const atom = family({
            environmentId: QUERY_ENVIRONMENT.environmentId,
            input: {} as never,
          });
          const registry = AtomRegistry.make();
          const unsubscribe = registry.subscribe(
            atom,
            (result) => {
              if (AsyncResult.isFailure(result))
                Deferred.doneUnsafe(surfaced, Exit.succeed(result.cause));
            },
            { immediate: true },
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              unsubscribe();
              registry.dispose();
            }),
          );
          yield* Deferred.await(firstSubscribed);
          // Lets any same-session retry run, so its resubscription can win the race below.
          yield* TestClock.adjust("1 minute");
          const outcome = yield* Effect.raceFirst(
            Deferred.await(surfaced).pipe(
              Effect.map((cause) => ({ _tag: "surfaced", cause }) as const),
            ),
            Deferred.await(resubscribed).pipe(Effect.as({ _tag: "resubscribed" } as const)),
          );

          expect(
            outcome._tag,
            "finite subscription resubscribed after a decode defect instead of failing its consumer",
          ).toBe("surfaced");
          if (outcome._tag === "surfaced") {
            expect(Cause.hasDies(outcome.cause)).toBe(true);
            expect(Schema.isSchemaError(Cause.squash(outcome.cause))).toBe(true);
          }
          expect(subscriptions).toBe(1);
        }),
      ),
  );
});
