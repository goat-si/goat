import {
  type ServerConfig,
  type AuthSessionState,
  MemorySpaceId,
  MemoryId,
  MemoryImportSourceId,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type RelayClientInstallProgressEvent,
  type ServerLifecycleStreamEvent,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
  CommandId,
  ThreadId,
  MessageId,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { reportAtomCommandResult } from "../state/runtime.ts";
import { createCommandPermissions } from "../state/commandPermissions.ts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  HubProxyConnectionTarget,
  BearerConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  EnvironmentRpcSubscriptionObserver,
  subscribeMemoryChanges,
  requestGuarded,
  EnvironmentRpcUnavailableError,
  RpcPermissionGuard,
  runStream,
  subscribe,
  subscribeDynamicWithSession,
} from "./client.ts";

vi.mock("../state/session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: memorySessions }),
}));
const memorySessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);
const memoryGrant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  scopes: allowed ? ["memory:read"] : [],
  permissions: allowed ? ["memory:read"] : [],
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "synthetic",
  },
});
const memoryPermissionHarness = Effect.fn(function* (allowed = true) {
  const atoms = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => atoms.dispose()));
  atoms.mount(memorySessions(TARGET.environmentId));
  atoms.set(memorySessions(TARGET.environmentId), AsyncResult.success(memoryGrant(allowed)));
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {} as EnvironmentRegistry["Service"]),
  );
  const permissions = createCommandPermissions(runtime, WS_METHODS.memoryChanges);
  expect(atoms.get(permissions.permissionAtom(TARGET.environmentId))).toBe(allowed);
  return { atoms, runtime };
});

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const INSTALL_CHECKING: RelayClientInstallProgressEvent = {
  type: "progress",
  stage: "checking",
};
const INSTALL_DOWNLOADING: RelayClientInstallProgressEvent = {
  type: "progress",
  stage: "downloading",
};

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const makeHarness = Effect.fn("TestEnvironmentRpc.makeHarness")(function* (
  target: EnvironmentSupervisor.EnvironmentSupervisor["Service"]["target"] = TARGET,
) {
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE);
  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.none(),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const retryCount = yield* Ref.make(0);
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state,
    session: activeSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  return {
    activeSession,
    retryCount,
    supervisor,
  };
});

describe("environment RPC", () => {
  it.effect("turns unsupported hub RPC defects into quiet expected failures", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness();
      const client = {
        [WS_METHODS.hubNodesImport]: () => Effect.die("Unknown request tag: hub.nodes.import"),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const result = yield* requestGuarded(WS_METHODS.hubNodesImport, {
        source: "desktop-catalog",
        catalog: { state: "readable", profiles: [] },
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
        Effect.exit,
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.hasDies(result.cause)).toBe(false);
        expect(Cause.squash(result.cause)).toBeInstanceOf(EnvironmentRpcUnavailableError);
        const reporter = { error: vi.fn(), warn: vi.fn() };
        reportAtomCommandResult(
          AsyncResult.failure(result.cause),
          { reportFailure: false },
          reporter,
        );
        expect(reporter.error).not.toHaveBeenCalled();
        expect(reporter.warn).not.toHaveBeenCalled();
      }
    }),
  );

  it.effect("preserves real hub RPC defects", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness();
      const client = {
        [WS_METHODS.hubNodesImport]: () => Effect.die("Storage failed"),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const result = yield* requestGuarded(WS_METHODS.hubNodesImport, {
        source: "desktop-catalog",
        catalog: { state: "readable", profiles: [] },
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
        Effect.exit,
      );
      expect(Exit.isFailure(result) && Cause.hasDies(result.cause)).toBe(true);
    }),
  );

  it.effect("binds finite streaming commands to one active session", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const secondEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const firstClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(firstEvents),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(secondEvents),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const resultFiber = yield* runStream(WS_METHODS.cloudInstallRelayClient, {}).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* Queue.offer(firstEvents, INSTALL_CHECKING);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* Queue.offer(secondEvents, INSTALL_DOWNLOADING);
      yield* Queue.offer(firstEvents, INSTALL_DOWNLOADING);

      expect(yield* Fiber.join(resultFiber)).toEqual([INSTALL_CHECKING, INSTALL_DOWNLOADING]);
    }),
  );

  it.effect("switches durable subscriptions when the supervisor replaces the session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const subscriptionChanges = yield* Queue.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();
      const awaitSubscriptions = Effect.fn("TestEnvironmentRpc.awaitSubscriptions")(function* (
        count: number,
      ) {
        for (;;) {
          if (subscriptions.length >= count) {
            return;
          }
          yield* Queue.take(subscriptionChanges);
        }
      });

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      yield* awaitSubscriptions(1);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* awaitSubscriptions(2);
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps the producer session on an old value buffered across a session switch", () =>
    Effect.gen(function* () {
      const firstSubscribed = yield* Deferred.make<void>();
      const secondSubscribed = yield* Deferred.make<void>();
      const firstValueBlocked = yield* Deferred.make<void>();
      const releaseFirstValue = yield* Deferred.make<void>();
      const firstValue = { source: "first", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const bufferedFirstValue = {
        source: "first",
        index: 2,
      } as unknown as ServerLifecycleStreamEvent;
      const secondValue = { source: "second", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromIterable([firstValue, bufferedFirstValue])),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(secondSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.make(secondValue)),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const { activeSession, supervisor } = yield* makeHarness();

      const resultFiber = yield* subscribeDynamicWithSession(
        WS_METHODS.subscribeServerLifecycle,
        () => Effect.succeed({}),
      ).pipe(
        Stream.mapEffect(([producerSession, value]) =>
          value === firstValue
            ? Deferred.succeed(firstValueBlocked, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirstValue)),
                Effect.as([producerSession, value] as const),
              )
            : Effect.succeed([producerSession, value] as const),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* SubscriptionRef.set(activeSession, Option.some(firstSession));
      yield* Deferred.await(firstSubscribed);
      yield* Deferred.await(firstValueBlocked);
      yield* SubscriptionRef.set(activeSession, Option.some(secondSession));
      yield* Deferred.await(secondSubscribed);
      yield* Deferred.succeed(releaseFirstValue, undefined);

      const result = yield* Fiber.join(resultFiber);
      expect(result).toEqual([
        [firstSession, firstValue],
        [firstSession, bufferedFirstValue],
        [secondSession, secondValue],
      ]);
    }),
  );

  it.effect("keeps durable subscriptions alive across a transport failure and new session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const subscriptionChanges = yield* Queue.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.fail(
            new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "socket closed",
                cause: new Error("socket closed"),
              }),
            }),
          );
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      while (subscriptions.length < 1) {
        yield* Queue.take(subscriptionChanges);
      }
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));

      while (subscriptions.length < 2) {
        yield* Queue.take(subscriptionChanges);
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("surfaces domain subscription failures without reconnecting", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () => Stream.fail(domainError),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const error = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(error).toBe(domainError);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps handled domain failures dormant until a replacement session arrives", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const subscriptions: string[] = [];
      const subscriptionChanges = yield* Queue.make<void>();
      const observedFailures: Error[] = [];
      const failureObserved = yield* Deferred.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.fail(domainError);
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          Queue.offerUnsafe(subscriptionChanges, undefined);
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: (cause) =>
            Effect.sync(() => {
              observedFailures.push(Cause.squash(cause) as Error);
              Deferred.doneUnsafe(failureObserved, Effect.void);
            }),
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(failureObserved);

      expect(subscriptions).toEqual(["first"]);
      expect(observedFailures).toEqual([domainError]);

      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      while (subscriptions.length < 2) {
        yield* Queue.take(subscriptionChanges);
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect.each(["input", "stream"] as const)(
    "does not classify %s subscription defects as expected failures",
    (where) =>
      Effect.gen(function* () {
        const defect = new Error("subscription invariant failed");
        let expectedFailureCount = 0;
        let inputs = 0;
        let streams = 0;
        const observedDefects: unknown[] = [];
        const client = {
          [WS_METHODS.subscribeTerminalEvents]: () => {
            streams += 1;
            return where === "stream" ? Stream.die(defect) : Stream.never;
          },
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();

        yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
        const exit = yield* subscribeDynamicWithSession(
          WS_METHODS.subscribeTerminalEvents,
          () =>
            Effect.sync(() => {
              inputs += 1;
            }).pipe(Effect.andThen(where === "input" ? Effect.die(defect) : Effect.succeed({}))),
          {
            onDefect: (cause) =>
              Effect.sync(() => {
                observedDefects.push(Cause.squash(cause));
              }),
            onExpectedFailure: () =>
              Effect.sync(() => {
                expectedFailureCount += 1;
              }),
            retryExpectedFailureAfter: "250 millis",
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true);
          expect(Cause.squash(exit.cause)).toBe(defect);
        }
        expect(inputs).toBe(1);
        expect(streams).toBe(where === "input" ? 0 : 1);
        expect(expectedFailureCount).toBe(0);
        expect(observedDefects).toEqual([defect]);
      }),
  );
});

describe("staged memory RPC", () => {
  const memorySpaceId = MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
  const memoryId = MemoryId.make("00000000-0000-4000-8000-000000000002");
  it.effect.each([undefined, false, true])(
    "dispatch gates caller history opt-in on selected session capability: %s",
    (supported) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const inputs: unknown[] = [];
        const client = {
          [WS_METHODS.memoryHistory]: (input: unknown) => {
            inputs.push(input);
            return Effect.succeed({});
          },
        } as unknown as WsRpcProtocolClient;
        yield* SubscriptionRef.set(
          h.activeSession,
          Option.some({
            ...session(client),
            initialConfig: Effect.succeed({
              environment: {
                capabilities: {
                  memory: {
                    protocolVersion: 1,
                    ...(supported === undefined ? {} : { refusedReverts: supported }),
                  },
                },
              },
            } as ServerConfig),
          }),
        );
        for (const optIn of [true, false]) {
          const input = {
            memorySpaceId,
            memoryId,
            limit: 10,
            ...(optIn ? { includeRefusedReverts: true as const } : {}),
          };
          yield* requestGuarded(WS_METHODS.memoryHistory, input).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor),
            Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
          );
          expect(inputs.at(-1)).toEqual({
            memorySpaceId,
            memoryId,
            limit: 10,
            ...(supported && optIn ? { includeRefusedReverts: true } : {}),
          });
          expect(input).toEqual({
            memorySpaceId,
            memoryId,
            limit: 10,
            ...(optIn ? { includeRefusedReverts: true } : {}),
          });
        }
      }),
  );
  it.effect.each([undefined, false, true] as const)(
    "gates retained space and resolution history on the selected session: %s",
    (supported) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const inputs: Array<{ method: string; input: unknown }> = [];
        const client = {
          [WS_METHODS.memorySyncStatus]: (input: unknown) => {
            inputs.push({ method: "sync", input });
            return Effect.succeed({});
          },
          [WS_METHODS.memoryHistory]: (input: unknown) => {
            inputs.push({ method: "history", input });
            return Effect.succeed({});
          },
        } as unknown as WsRpcProtocolClient;
        yield* SubscriptionRef.set(
          h.activeSession,
          Option.some({
            ...session(client),
            initialConfig: Effect.succeed({
              environment: {
                capabilities: {
                  memory: {
                    protocolVersion: 1,
                    ...(supported === undefined
                      ? {}
                      : {
                          resolutionInputs: supported,
                          retainedLocalSpace: supported,
                          generationHold: supported,
                        }),
                  },
                },
              },
            } as ServerConfig),
          }),
        );
        const provide = Effect.provideService(
          EnvironmentSupervisor.EnvironmentSupervisor,
          h.supervisor,
        );
        const permit = Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void });
        yield* requestGuarded(WS_METHODS.memorySyncStatus, {
          includeRetainedLocalSpaceId: true,
        }).pipe(provide, permit);
        expect(inputs).toEqual([
          {
            method: "sync",
            input: supported
              ? { includeRetainedLocalSpaceId: true, includeGenerationHold: true }
              : {},
          },
        ]);
        const result = yield* requestGuarded(WS_METHODS.memoryHistory, {
          memorySpaceId,
          memoryId,
          limit: 10,
          resolutionInputsFor: "00000000-0000-4000-8000-000000000007" as never,
        }).pipe(provide, permit, Effect.exit);
        expect(Exit.isSuccess(result)).toBe(supported === true);
        expect(inputs.filter((value) => value.method === "history")).toHaveLength(
          supported ? 1 : 0,
        );
      }),
  );
  it.effect.each([undefined, false, true] as const)(
    "gates turn-start fit on import preview for the selected session: %s",
    (supported) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const inputs: Array<{ method: string; input: unknown }> = [];
        const client = {
          [WS_METHODS.memoryImportProvider]: (input: unknown) => {
            inputs.push({ method: "import", input });
            return Effect.succeed({});
          },
        } as unknown as WsRpcProtocolClient;
        yield* SubscriptionRef.set(
          h.activeSession,
          Option.some({
            ...session(client),
            initialConfig: Effect.succeed({
              environment: {
                capabilities: {
                  memory: {
                    protocolVersion: 1,
                    importProvider: true,
                    ...(supported === undefined ? {} : { importTurnStartFit: supported }),
                  },
                },
              },
            } as ServerConfig),
          }),
        );
        const provide = Effect.provideService(
          EnvironmentSupervisor.EnvironmentSupervisor,
          h.supervisor,
        );
        const permit = Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void });
        const sourceId = MemoryImportSourceId.make("00000000-0000-4000-8000-000000000003");
        const discover = {
          memorySpaceId,
          action: "discover" as const,
          format: "claude" as const,
        };
        const hintedDiscover = {
          memorySpaceId,
          action: "discover" as const,
          format: "codex" as const,
          includeTurnStartFit: true as const,
        };
        yield* requestGuarded(WS_METHODS.memoryImportProvider, discover).pipe(provide, permit);
        yield* requestGuarded(WS_METHODS.memoryImportProvider, hintedDiscover as never).pipe(
          provide,
          permit,
        );
        expect(inputs).toEqual([
          { method: "import", input: discover },
          { method: "import", input: hintedDiscover },
        ]);
        for (const optedIn of [true, false] as const) {
          const preview = {
            memorySpaceId,
            action: "preview" as const,
            sourceId,
            ...(optedIn ? { includeTurnStartFit: true as const } : {}),
          };
          yield* requestGuarded(WS_METHODS.memoryImportProvider, preview).pipe(provide, permit);
          expect(inputs.at(-1)).toEqual({
            method: "import",
            input: {
              memorySpaceId,
              action: "preview",
              sourceId,
              ...(supported === true ? { includeTurnStartFit: true } : {}),
            },
          });
          expect(preview).toEqual({
            memorySpaceId,
            action: "preview",
            sourceId,
            ...(optedIn ? { includeTurnStartFit: true } : {}),
          });
        }
      }),
  );
  it.effect("denies a raw memory subscription without a read grant", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      let opened = false;
      const client = {
        [WS_METHODS.memoryChanges]: () => {
          opened = true;
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        h.activeSession,
        Option.some({
          ...session(client),
          initialConfig: Effect.succeed({
            environment: { capabilities: { memory: { protocolVersion: 1 } } },
          } as ServerConfig),
        }),
      );
      const failure = yield* subscribe(WS_METHODS.memoryChanges, { memorySpaceId }).pipe(
        Stream.runDrain,
        Effect.flip,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor),
      );
      expect(failure._tag).toBe("EnvironmentAuthorizationError");
      expect(opened).toBe(false);
    }),
  );
  it.effect(
    "reports an absent staged method as unavailable instead of calling a different client",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* SubscriptionRef.set(
          h.activeSession,
          Option.some({
            ...session({} as WsRpcProtocolClient),
            initialConfig: Effect.succeed({
              environment: {
                capabilities: { memory: { protocolVersion: 1, importProvider: true } },
              },
            } as ServerConfig),
          }),
        );
        const failure = yield* requestGuarded(WS_METHODS.memoryImportProvider, {
          memorySpaceId,
          action: "discover",
          format: "claude",
        }).pipe(
          Effect.flip,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor),
          Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
        );
        expect(failure._tag).toBe("EnvironmentRpcUnavailableError");
      }),
  );
  it.effect(
    "rejects import when the selected server does not advertise its import capability",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        let invoked = false;
        const client = {
          [WS_METHODS.memoryImportProvider]: () => {
            invoked = true;
            return Effect.succeed({ action: "discover", sources: [] });
          },
        } as unknown as WsRpcProtocolClient;
        yield* SubscriptionRef.set(
          h.activeSession,
          Option.some({
            ...session(client),
            initialConfig: Effect.succeed({
              environment: { capabilities: { memory: { protocolVersion: 1 } } },
            } as ServerConfig),
          }),
        );
        const failure = yield* requestGuarded(WS_METHODS.memoryImportProvider, {
          memorySpaceId,
          action: "discover",
          format: "claude",
        }).pipe(
          Effect.flip,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor),
          Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
        );
        expect(failure._tag).toBe("EnvironmentRpcUnavailableError");
        expect(invoked).toBe(false);
      }),
  );
  it.effect.each(["capability", "method"] as const)(
    "rejects a missing memory stream %s before opening it",
    (missing) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        let opened = false;
        const client =
          missing === "method"
            ? {}
            : {
                [WS_METHODS.memoryChanges]: () => {
                  opened = true;
                  return Stream.never;
                },
              };
        yield* SubscriptionRef.set(
          h.activeSession,
          Option.some({
            ...session(client as unknown as WsRpcProtocolClient),
            initialConfig: Effect.succeed({
              environment: {
                capabilities: missing === "capability" ? {} : { memory: { protocolVersion: 1 } },
              },
            } as ServerConfig),
          }),
        );
        const failure = yield* subscribe(WS_METHODS.memoryChanges, { memorySpaceId }).pipe(
          Stream.runDrain,
          Effect.flip,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor),
          Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
        );
        expect(failure._tag).toBe("MemoryRpcError");
        expect(opened).toBe(false);
      }),
  );
  it.effect.each(["capability", "method", "grant"] as const)(
    "direct memory subscription rejects missing %s at its own boundary",
    (missing) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness();
          const { runtime, atoms } = yield* memoryPermissionHarness(missing !== "grant");
          let opened = false;
          let observed = false;
          const fixed = {
            ...session(
              (missing === "method"
                ? {}
                : {
                    [WS_METHODS.memoryChanges]: () => {
                      opened = true;
                      return Stream.empty;
                    },
                  }) as unknown as WsRpcProtocolClient,
            ),
            initialConfig: Effect.succeed({
              environment: {
                capabilities: missing === "capability" ? {} : { memory: { protocolVersion: 1 } },
              },
            } as ServerConfig),
          };
          const result = yield* subscribeMemoryChanges(runtime, atoms, fixed, {
            memorySpaceId,
          }).pipe(
            Stream.runDrain,
            Effect.exit,
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor),
            Effect.provideService(EnvironmentRpcSubscriptionObserver, {
              observe: () =>
                Effect.sync(() => {
                  observed = true;
                  return Effect.void;
                }),
            }),
          );
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            const error = Option.getOrThrow(Cause.findErrorOption(result.cause));
            expect(error._tag).toBe(
              missing === "grant" ? "EnvironmentAuthorizationError" : "MemoryRpcError",
            );
            if (error._tag === "MemoryRpcError") expect(error.code).toBe("unsupported_operation");
          }
          expect(opened).toBe(false);
          expect(observed).toBe(false);
        }),
      ),
  );

  it.effect("direct memory subscription completes its observer when the granted scope closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const { runtime, atoms } = yield* memoryPermissionHarness();
        const opened = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const fixed = {
          ...session({
            [WS_METHODS.memoryChanges]: () =>
              Stream.fromEffect(
                Deferred.succeed(opened, undefined).pipe(Effect.andThen(Effect.never)),
              ),
          } as unknown as WsRpcProtocolClient),
          initialConfig: Effect.succeed({
            environment: { capabilities: { memory: { protocolVersion: 1 } } },
          } as ServerConfig),
        };
        const observations: string[] = [];
        yield* subscribeMemoryChanges(runtime, atoms, fixed, { memorySpaceId }).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor),
          Effect.provideService(EnvironmentRpcSubscriptionObserver, {
            observe: ({ environmentId, method, input }) =>
              Effect.sync(() => {
                observations.push(`${environmentId}:${method}`);
                expect(input).toEqual({ memorySpaceId });
                return Deferred.succeed(completed, undefined);
              }),
          }),
          Effect.forkIn(scope),
        );
        yield* Deferred.await(opened);
        expect(observations).toEqual([`${TARGET.environmentId}:${WS_METHODS.memoryChanges}`]);
        expect(yield* Deferred.isDone(completed)).toBe(false);
        yield* Scope.close(scope, Exit.void);
        yield* Deferred.await(completed);
      }),
    ),
  );

  it.effect("rejects a body query when memory capability is absent", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      let invoked = false;
      const client = {
        [WS_METHODS.memoryList]: () => {
          invoked = true;
          return Effect.never;
        },
      };
      yield* SubscriptionRef.set(
        h.activeSession,
        Option.some({
          ...session(client as unknown as WsRpcProtocolClient),
          initialConfig: Effect.succeed({ environment: { capabilities: {} } } as ServerConfig),
        }),
      );
      const failure = yield* requestGuarded(WS_METHODS.memoryList, {
        memorySpaceId,
        includeQuarantined: false,
        limit: 10,
      }).pipe(
        Effect.flip,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor),
        Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
      );
      expect(failure._tag).toBe("EnvironmentRpcUnavailableError");
      expect(invoked).toBe(false);
    }),
  );
});

it.effect(
  "hub guard: a hub route blocks thread.delete and permits message.dispatch; a direct route sends both",
  () =>
    Effect.gen(function* () {
      const sent: Array<unknown> = [];
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (input: unknown) =>
          Effect.sync(() => {
            sent.push(input);
            return { sequence: 1 };
          }),
      } as unknown as WsRpcProtocolClient;
      const hub = yield* makeHarness(
        new HubProxyConnectionTarget({
          environmentId: TARGET.environmentId,
          label: TARGET.label,
          connectionId: "hub:primary:node-1",
        }),
      );
      const direct = yield* makeHarness(
        new BearerConnectionTarget({
          environmentId: TARGET.environmentId,
          label: TARGET.label,
          connectionId: "direct-node",
        }),
      );
      yield* SubscriptionRef.set(hub.activeSession, Option.some(session(client)));
      yield* SubscriptionRef.set(direct.activeSession, Option.some(session(client)));
      const remove = {
        type: "thread.delete" as const,
        commandId: CommandId.make("c-delete"),
        threadId: ThreadId.make("thread-1"),
      };
      const followUp = {
        type: "message.dispatch" as const,
        commandId: CommandId.make("c-send"),
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("m1"),
        createdBy: "user" as const,
        creationSource: "mobile" as const,
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "start_immediately" as const },
      };
      const viaHub = Effect.provideService(
        EnvironmentSupervisor.EnvironmentSupervisor,
        hub.supervisor,
      );
      const viaDirect = Effect.provideService(
        EnvironmentSupervisor.EnvironmentSupervisor,
        direct.supervisor,
      );
      const refused = yield* Effect.flip(
        requestGuarded(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, remove).pipe(viaHub),
      );
      expect(refused).toBeInstanceOf(EnvironmentAuthorizationError);
      expect(refused).toMatchObject({ requiredScope: "hub:proxy" });
      expect(sent).toEqual([]);
      yield* requestGuarded(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, followUp).pipe(viaHub);
      expect(sent).toEqual([followUp]);
      yield* requestGuarded(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, remove).pipe(viaDirect);
      yield* requestGuarded(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, followUp).pipe(viaDirect);
      expect(sent).toEqual([followUp, remove, followUp]);
    }),
);
