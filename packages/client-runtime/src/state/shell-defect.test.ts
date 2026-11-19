import { EnvironmentId, ORCHESTRATION_V2_WS_METHODS } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { AVAILABLE_CONNECTION_STATE, PrimaryConnectionTarget } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import * as RpcSession from "../rpc/session.ts";
import { v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";
import { makeEnvironmentShellState } from "./shell.ts";
import * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";

it.effect("resubscribes after a shell stream defect without a reconnect", () =>
  Effect.gen(function* () {
    const target = new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("defect-env"),
      label: "test",
      httpBaseUrl: "https://example.test",
      wsBaseUrl: "wss://example.test",
    });
    const prepared = {
      environmentId: target.environmentId,
      label: target.label,
      httpBaseUrl: target.httpBaseUrl,
      socketUrl: target.wsBaseUrl,
      httpAuthorization: null,
      target,
    };
    const calls = yield* Ref.make(0);
    const started = yield* Deferred.make<void>();
    const client = {
      [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
        Stream.unwrap(
          Ref.updateAndGet(calls, (n) => n + 1).pipe(
            Effect.tap(() => Deferred.succeed(started, undefined)),
            Effect.map((n) => (n === 1 ? Stream.die(new Error("defect")) : Stream.never)),
          ),
        ),
    } as unknown as WsRpcProtocolClient;
    const session = {
      client,
      initialConfig: Effect.succeed({ shellResumeCompletionMarker: true } as never),
      subscribeServerConfig: (input) => client.subscribeServerConfig(input ?? {}),
      ready: Effect.void,
      probe: Effect.void,
      inboundFrames: Effect.succeed(0),
      closed: Effect.never,
    } satisfies RpcSession.RpcSession;
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target,
      state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
      session: yield* SubscriptionRef.make(Option.some(session)),
      prepared: yield* SubscriptionRef.make(Option.some(prepared)),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    const cache = Persistence.EnvironmentCacheStore.of({
      loadShellMeta: () => Effect.succeedNone,
      saveShellMeta: () => Effect.void,
      loadShell: () => Effect.succeedSome(v2ShellSnapshot),
      saveShell: () => Effect.void,
      loadThread: () => Effect.succeedNone,
      saveThread: () => Effect.void,
      removeThread: () => Effect.void,
      loadServerConfig: () => Effect.succeedNone,
      saveServerConfig: () => Effect.void,
      loadVcsRefs: () => Effect.succeedNone,
      saveVcsRefs: () => Effect.void,
      removeVcsRefs: () => Effect.void,
      clearVcsRefs: () => Effect.void,
      clear: () => Effect.void,
    });
    yield* makeEnvironmentShellState().pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, {
        load: () => Effect.succeedNone,
      }),
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("250 millis");
    expect(yield* Ref.get(calls)).toBe(2);
  }),
);
