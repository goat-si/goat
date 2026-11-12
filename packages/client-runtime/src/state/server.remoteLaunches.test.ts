import {
  EnvironmentId,
  type RemoteLaunch,
  type ServerConfig,
  ThreadId,
  WS_METHODS,
} from "@goat/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const CONFIG = { settings: {}, providers: [] } as unknown as ServerConfig;
const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const session = (client: WsRpcProtocolClient): RpcSession => ({
  client,
  initialConfig: Effect.succeed(CONFIG),
  subscribeServerConfig: (input) => client.subscribeServerConfig(input ?? {}),
  ready: Effect.void,
  probe: Effect.void,
  inboundFrames: Effect.succeed(0),
  closed: Effect.never,
});

describe("remote launches", () => {
  it.effect(
    "a host that stops answering while the remote launch list is open shows there without a remount",
    () =>
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        const running: RemoteLaunch = {
          host: "mini",
          threadId: ThreadId.make("remote-thread"),
          title: "Long build",
          launcherThreadId: ThreadId.make("launcher"),
          source: "thread",
          state: "running",
          latest: null,
          hostUnavailableSince: null,
          updatedAt: "2026-11-08T12:55:00.000Z",
          dismissable: false,
          dismissedAt: null,
        };
        let listed = running;
        const client = {
          [WS_METHODS.remoteLaunchesList]: () =>
            Effect.sync(() => ({ launches: [listed], truncated: false })),
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            desired: true,
            phase: "connected",
          }),
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const runtime = Atom.runtime(
          Layer.merge(
            Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
              run: (_environmentId, effect) =>
                Effect.provideService(
                  effect,
                  EnvironmentSupervisor.EnvironmentSupervisor,
                  supervisor,
                ),
              followStream: (_environmentId, stream) =>
                Stream.provideService(
                  stream,
                  EnvironmentSupervisor.EnvironmentSupervisor,
                  supervisor,
                ),
            } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
            Layer.succeed(
              Persistence.EnvironmentCacheStore,
              {} as Persistence.EnvironmentCacheStore["Service"],
            ),
          ),
        );
        const atoms = createServerEnvironmentAtoms(runtime, {
          initialConfigValueAtom: () => Atom.make(CONFIG),
        });
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        );
        const seen = yield* Queue.unbounded<RemoteLaunch>();
        const unsubscribe = registry.subscribe(
          atoms.remoteLaunches({ environmentId: TARGET.environmentId, input: {} }),
          (result) => {
            const launch = Option.getOrNull(AsyncResult.value(result))?.launches[0];
            if (launch !== undefined && !result.waiting) Queue.offerUnsafe(seen, launch);
          },
          { immediate: true },
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        expect(yield* Queue.take(seen)).toMatchObject({ hostUnavailableSince: null });

        listed = {
          ...running,
          hostUnavailableSince: "2026-11-12T11:00:00.000Z",
          dismissable: true,
        };
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));
        expect(yield* Queue.take(seen)).toMatchObject({
          hostUnavailableSince: "2026-11-12T11:00:00.000Z",
          dismissable: true,
        });
      }).pipe(Effect.scoped),
  );
});
