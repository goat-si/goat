import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  WS_METHODS,
  type CuaHostStatus,
  type ServerConfig,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { RpcClientError } from "effect/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
  type NetworkStatus,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const config = {
  settings: DEFAULT_SERVER_SETTINGS,
  environment: { capabilities: {}, serverVersion: "test" },
} as unknown as ServerConfig;
const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("readiness-host"),
  label: "Readiness host",
  httpBaseUrl: "https://readiness.example.test",
  wsBaseUrl: "wss://readiness.example.test",
});

const fixture = Effect.fn("ComputerUseReadiness.test.fixture")(function* (unsupported: boolean) {
  const ticks = yield* Queue.unbounded<{ revision: number }>();
  const subscribed = yield* Deferred.make<void>();
  const subscriptions = yield* Ref.make(0);
  const status = yield* Ref.make<CuaHostStatus>({ platform: "darwin", running: false });
  const client = {
    [WS_METHODS.serverCheckComputerUse]: () => Ref.get(status),
    [WS_METHODS.computerUseStatusChanges]: () =>
      Stream.unwrap(
        Ref.update(subscriptions, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(subscribed, undefined)),
          Effect.as(
            unsupported
              ? Stream.fail(
                  new RpcClientError.RpcClientError({
                    reason: new RpcClientError.RpcClientDefect({
                      message: "Unknown request tag: computerUse.statusChanges",
                      cause: new Error("Unknown request tag: computerUse.statusChanges"),
                    }),
                  }),
                )
              : Stream.fromQueue(ticks),
          ),
        ),
      ),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed(config),
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connected",
      attempt: 1,
      generation: 1,
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _id,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map(),
  );
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>("online");
  // The atoms run on this test's clock, so adjusting it reaches any retry they schedule.
  const clock = yield* Clock.Clock;
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(Clock.Clock, clock),
      Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
        entries,
        networkStatus,
        run,
        followStream,
      }),
      Layer.mock(Persistence.EnvironmentCacheStore)({
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
      }),
    ),
  );
  const initialConfig = Atom.make<ServerConfig | null>(config);
  const server = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: () => initialConfig,
  });
  const atom = server.computerUse({ environmentId: target.environmentId, input: {} });
  const registry = AtomRegistry.make();
  const values = yield* Queue.unbounded<CuaHostStatus>();
  const unsubscribe = registry.subscribe(
    atom,
    (result) => {
      if (AsyncResult.isSuccess(result) && !result.waiting) Queue.offerUnsafe(values, result.value);
    },
    { immediate: true },
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unsubscribe();
      registry.dispose();
    }),
  );
  yield* Deferred.await(subscribed);
  expect(yield* Queue.take(values)).toEqual({ platform: "darwin", running: false });
  return { ticks, subscriptions, status, registry, initialConfig, values };
});

it.effect("refreshes mounted readiness and running status on host revisions without a reload", () =>
  Effect.gen(function* () {
    const f = yield* fixture(false);
    const reported: CuaHostStatus = {
      platform: "darwin",
      running: true,
      readiness: {
        grants: { accessibility: "granted", screenCapture: "granted" },
        helper: "authenticated",
        capture: "ready",
        tree: "ready",
        input: "background",
        blockers: [],
        reasons: [],
      },
    };
    yield* Ref.set(f.status, reported);
    yield* Queue.offer(f.ticks, { revision: 1 });
    expect(yield* Queue.take(f.values)).toEqual(reported);
    yield* Ref.set(f.status, { ...reported, running: false });
    yield* Queue.offer(f.ticks, { revision: 2 });
    expect(yield* Queue.take(f.values)).toEqual({ ...reported, running: false });
    expect(yield* Ref.get(f.subscriptions)).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect(
  "keeps the status query and setting refresh working on older servers without retrying",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(true);
      yield* TestClock.adjust("1 minute");
      expect(yield* Ref.get(f.subscriptions)).toBe(1);
      yield* Ref.set(f.status, { platform: "darwin", running: true });
      f.registry.set(f.initialConfig, {
        ...config,
        settings: { ...config.settings, enableCua: !config.settings.enableCua },
      });
      expect(yield* Queue.take(f.values)).toEqual({ platform: "darwin", running: true });
      expect(yield* Ref.get(f.subscriptions)).toBe(1);
    }).pipe(Effect.scoped),
);
