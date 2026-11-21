import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { AVAILABLE_CONNECTION_STATE, type PreparedConnection } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type * as RpcSession from "../rpc/session.ts";
import { PREPARED, SERVER_CONFIG, TARGET } from "../rpc/sessionTestFixtures.ts";
import { makeEnvironmentServerConfigState } from "./serverConfigState.ts";

it.effect("does not persist the connection's server clock sample", () =>
  Effect.gen(function* () {
    const saved = yield* Queue.unbounded<unknown>();
    const session = {
      subscribeServerConfig: () =>
        Stream.make({
          version: 1 as const,
          type: "snapshot" as const,
          config: { ...SERVER_CONFIG, serverTime: "2026-01-01T00:00:00Z" },
        }).pipe(Stream.concat(Stream.never)),
    } as unknown as RpcSession.RpcSession;
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: TARGET,
      state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
      session: yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session),
      ),
      prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
        Option.some(PREPARED),
      ),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    const cache = Persistence.EnvironmentCacheStore.of({
      loadShellMeta: () => Effect.succeedNone,
      saveShellMeta: () => Effect.void,
      loadShell: () => Effect.succeedNone,
      saveShell: () => Effect.void,
      loadThread: () => Effect.succeedNone,
      saveThread: () => Effect.void,
      removeThread: () => Effect.void,
      loadServerConfig: () => Effect.succeedNone,
      saveServerConfig: (_id, config) => Queue.offer(saved, config).pipe(Effect.asVoid),
      loadVcsRefs: () => Effect.succeedNone,
      saveVcsRefs: () => Effect.void,
      removeVcsRefs: () => Effect.void,
      clearVcsRefs: () => Effect.void,
      clear: () => Effect.void,
    });
    const state = yield* makeEnvironmentServerConfigState({}).pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    );
    yield* SubscriptionRef.changes(state).pipe(Stream.filter(Option.isSome), Stream.runHead);
    yield* TestClock.adjust("500 millis");
    const result = yield* Queue.take(saved);
    expect(result).not.toHaveProperty("serverTime");
  }),
);
