import {
  EnvironmentId,
  ServerSelfUpdateError,
  type ServerConfig,
  type ServerLifecycleStreamEvent,
  type ServerSelfUpdateOutcome,
  WS_METHODS,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createServerEnvironmentAtoms,
  serverUpdateStateAtom,
  matchesServerUpdateReadyEvent,
  validateServerUpdateReadyEvent,
} from "./server.ts";

const CONFIG = {
  availableEditors: [],
  issues: [],
  keybindings: {},
  keybindingsConfigPath: null,
  observability: null,
  providers: [],
  settings: {},
  environment: { capabilities: { environmentThemes: true } },
} as unknown as ServerConfig;

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.succeed(CONFIG),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input ?? {}),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

describe("accepted server update recovery", () => {
  it.effect.each([
    { loss: "interrupt", resumes: true },
    { loss: "socket", resumes: true },
    { loss: "server_error", resumes: false },
    { loss: "no_progress", resumes: false },
    { loss: "cancel", resumes: false },
    { loss: "socket", method: "respawn", resumes: true },
    { loss: "socket", method: "desktop-managed", resumes: false },
  ] as const)("handles $loss with $method and recovery=$resumes", (scenario) =>
    Effect.gen(function* () {
      const { loss, resumes } = scenario;
      const method = "method" in scenario ? scenario.method : "boot-service";
      const observing = yield* Deferred.make<void>();
      const cancelFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      const oldReadyObserved = yield* Deferred.make<void>();
      const readyEvents =
        yield* Queue.unbounded<Parameters<typeof matchesServerUpdateReadyEvent>[1]>();
      const config = {
        ...CONFIG,
        environment: {
          ...CONFIG.environment,
          serverVersion: "0.0.30",
          capabilities: { serverSelfUpdate: method, serverSelfUpdateProgress: true },
        },
      } as ServerConfig;
      const ready = (serverVersion: string) =>
        ({
          version: 1,
          sequence: 1,
          type: "ready",
          payload: { at: "2026-09-01T00:00:00.000Z", environment: { serverVersion } },
        }) as Parameters<typeof matchesServerUpdateReadyEvent>[1];
      let requested = false;
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.never,
        // Before the request, a boot-service update reads the accepting server's ready.
        [WS_METHODS.subscribeServerLifecycle]: () =>
          requested
            ? Stream.fromEffect(Deferred.succeed(observing, undefined)).pipe(
                Stream.drain,
                Stream.concat(Stream.fromQueue(readyEvents)),
                Stream.tap((event) =>
                  event.payload.environment.serverVersion === "0.0.30"
                    ? Deferred.succeed(oldReadyObserved, undefined)
                    : Effect.void,
                ),
              )
            : Stream.make(ready("0.0.30")).pipe(Stream.concat(Stream.never)),
        [WS_METHODS.serverUpdateServerWithProgress]: () =>
          Stream.unwrap(
            Effect.sync(() => {
              requested = true;
              return loss === "no_progress"
                ? Stream.empty
                : Stream.make({ type: "progress" as const, stage: "downloading" as const });
            }),
          ).pipe(
            Stream.concat(
              Stream.fromEffect(
                loss === "cancel"
                  ? Effect.fiber.pipe(
                      Effect.flatMap((fiber) => Deferred.succeed(cancelFiber, fiber)),
                      Effect.andThen(Effect.never),
                    )
                  : loss === "interrupt"
                    ? Effect.interrupt
                    : Effect.fail(
                        loss === "server_error"
                          ? new ServerSelfUpdateError({
                              reason: "Archive verification failed.",
                            })
                          : new RpcClientError.RpcClientError({
                              reason: new Socket.SocketCloseError({ code: 1006 }),
                            }),
                      ),
              ),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const runStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["runStream"] = (
        _id,
        stream,
      ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
        run,
        runStream,
        followStream: runStream,
        stateChanges: () => Stream.never,
        retryNow: () => Effect.void,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const runtime = Atom.runtime(
        Layer.mergeAll(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Layer.succeed(RpcPermissionGuard, { authorize: () => Effect.void }),
          Layer.succeed(Persistence.EnvironmentCacheStore, {
            loadServerConfig: () => Effect.succeedNone,
          } as unknown as Persistence.EnvironmentCacheStore["Service"]),
        ),
      );
      const atoms = createServerEnvironmentAtoms(runtime, {
        initialConfigValueAtom: () => Atom.make(config),
      });
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
        Effect.sync(() => value.dispose()),
      );
      const pending = atoms.updateServer.run(registry, {
        environmentId: TARGET.environmentId,
        input: { targetVersion: "0.0.31" },
      });
      if (loss === "cancel") {
        yield* Fiber.interrupt(yield* Deferred.await(cancelFiber));
        const cancelled = yield* Effect.promise(() => pending);
        expect(cancelled._tag).toBe("Failure");
        if (cancelled._tag === "Failure")
          expect(Cause.hasInterruptsOnly(cancelled.cause)).toBe(true);
        expect(registry.get(serverUpdateStateAtom(TARGET.environmentId))).toEqual({
          status: "idle",
        });
        expect(yield* Deferred.isDone(observing)).toBe(false);
        return;
      }
      const first = yield* Effect.raceFirst(
        Effect.promise(() => pending).pipe(Effect.as("settled")),
        Deferred.await(observing).pipe(Effect.as("observing")),
      );
      if (!resumes) {
        expect(first).toBe("settled");
        expect(AsyncResult.isFailure(yield* Effect.promise(() => pending))).toBe(true);
        expect(registry.get(serverUpdateStateAtom(TARGET.environmentId))).toMatchObject({
          status: "failed",
        });
        return;
      }
      expect(first).toBe("observing");
      expect(registry.get(serverUpdateStateAtom(TARGET.environmentId))).toMatchObject({
        status: "running",
        stage: "resuming",
      });
      yield* Queue.offer(readyEvents, ready("0.0.30"));
      yield* Deferred.await(oldReadyObserved);
      expect(registry.get(serverUpdateStateAtom(TARGET.environmentId))).toMatchObject({
        status: "running",
      });
      yield* Queue.offer(readyEvents, ready("0.0.31"));
      expect(AsyncResult.isSuccess(yield* Effect.promise(() => pending))).toBe(true);
      expect(registry.get(serverUpdateStateAtom(TARGET.environmentId))).toEqual({
        status: "idle",
      });
    }).pipe(Effect.scoped),
  );
});

describe("launcher update resume", () => {
  const UPDATE_CONFIG = {
    ...CONFIG,
    environment: {
      serverVersion: "0.0.30",
      capabilities: { serverSelfUpdate: "boot-service", serverSelfUpdateProgress: true },
    },
  } as unknown as ServerConfig;

  const ready = (at: string, serverVersion: string, updateOutcome?: ServerSelfUpdateOutcome) =>
    ({
      version: 1,
      sequence: 1,
      type: "ready",
      payload: { at, environment: { serverVersion }, ...(updateOutcome ? { updateOutcome } : {}) },
    }) as ServerLifecycleStreamEvent;
  const after = (delay: Duration.Input, event: ServerLifecycleStreamEvent) =>
    Stream.fromEffect(Effect.as(Effect.sleep(delay), event));
  const committed = (id: string, fromVersion: string, targetVersion: string) => ({
    id,
    fromVersion,
    targetVersion,
    status: "committed" as const,
  });
  const ACCEPTING = ready("2026-08-01T00:00:00.000Z", "0.0.30");
  const REPLACEMENT = ready("2026-08-01T00:05:00.000Z", "0.0.31");

  // Lifecycle subscriptions opened before the update is acknowledged reach the accepting
  // process; later ones reach whatever the host has become.
  const launchUpdate = Effect.fn("ServerUpdateTest.launchUpdate")(function* (host: {
    readonly accepting: Stream.Stream<ServerLifecycleStreamEvent>;
    readonly resumed: Stream.Stream<ServerLifecycleStreamEvent>;
    readonly reconnectAfterBaseline?: boolean;
  }) {
    const started = yield* Deferred.make<void>();
    const resumeSubscribed = yield* Deferred.make<void>();
    let acknowledged = false;
    const client = {
      [WS_METHODS.subscribeServerConfig]: () => Stream.never,
      [WS_METHODS.serverUpdateServerWithProgress]: () =>
        Stream.fromEffect(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(
              Effect.sync(() => {
                acknowledged = true;
                return {
                  type: "complete" as const,
                  result: {
                    targetVersion: "0.0.31",
                    method: "boot-service" as const,
                    updateId: "update-1",
                  },
                };
              }),
            ),
          ),
        ),
      [WS_METHODS.subscribeServerLifecycle]: () => {
        const events = acknowledged
          ? Deferred.succeed(resumeSubscribed, undefined).pipe(Effect.as(host.resumed))
          : Effect.succeed(host.accepting);
        const reconnect =
          !acknowledged && host.reconnectAfterBaseline === true
            ? SubscriptionRef.set(supervisor.session, Option.some(updateSession()))
            : Effect.void;
        return Stream.unwrap(
          Deferred.succeed(started, undefined).pipe(Effect.andThen(events)),
        ).pipe(Stream.concat(Stream.never), Stream.ensuring(reconnect));
      },
    } as unknown as WsRpcProtocolClient;
    const updateSession = (): RpcSession => ({
      ...session(client),
      initialConfig: Effect.succeed(UPDATE_CONFIG),
    });
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: TARGET,
      state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
      session: yield* SubscriptionRef.make(Option.some(updateSession())),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
    type Environments = EnvironmentRegistry.EnvironmentRegistry["Service"];
    const run: Environments["run"] = (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
    const runStream: Environments["runStream"] = (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
    const environments = EnvironmentRegistry.EnvironmentRegistry.of({
      run,
      runStream,
      followStream: runStream,
      stateChanges: () => Stream.never,
      retryNow: () => Effect.void,
    } as unknown as Environments);
    const cache = Persistence.EnvironmentCacheStore.of({
      loadShellMeta: () => Effect.succeedNone,
      saveShellMeta: () => Effect.void,
      loadShell: () => Effect.succeedNone,
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
    // Share the test clock so the command's timers and the host's restart run on TestClock.
    const runtime = Atom.runtime(
      Layer.mergeAll(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
        Layer.succeed(Persistence.EnvironmentCacheStore, cache),
        Layer.succeed(Clock.Clock, yield* Clock.Clock),
        Layer.succeed(Scheduler.Scheduler, yield* Scheduler.Scheduler),
      ),
    );
    const initialConfigValueAtom = Atom.make(UPDATE_CONFIG);
    const atoms = createServerEnvironmentAtoms(runtime, {
      initialConfigValueAtom: () => initialConfigValueAtom,
    });
    const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
      Effect.sync(() => registry.dispose()),
    );
    const updateStateAtom = serverUpdateStateAtom(TARGET.environmentId);
    yield* AtomRegistry.mount(registry, updateStateAtom);

    yield* Effect.promise(() =>
      atoms.updateServer.run(registry, {
        environmentId: TARGET.environmentId,
        input: { targetVersion: "0.0.31" },
      }),
    ).pipe(Effect.forkScoped);
    return {
      // The host saw its first call: the update request or a lifecycle subscription.
      started: Deferred.await(started),
      resumeSubscribed: Deferred.await(resumeSubscribed),
      state: () => registry.get(updateStateAtom),
    };
  });

  const UNCOMMITTED_RESUME = {
    status: "failed",
    stage: "resuming",
    fromVersion: "0.0.30",
    targetVersion: "0.0.31",
    message: "The service launcher resumed without committing the requested server version.",
  };

  it.effect("fails promptly when a server the launcher did not start comes back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const update = yield* launchUpdate({
          accepting: Stream.make(ACCEPTING),
          resumed: after("1 second", ACCEPTING).pipe(Stream.concat(after("1 minute", REPLACEMENT))),
        });
        yield* update.resumeSubscribed;

        yield* TestClock.adjust("1 second");
        expect(update.state()).toMatchObject({ status: "running", stage: "resuming" });
        yield* TestClock.adjust("1 minute");
        expect(update.state()).toEqual(UNCOMMITTED_RESUME);
      }),
    ),
  );

  it.effect(
    "fails promptly when the accepting server's replay arrives after a quick acknowledgement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const update = yield* launchUpdate({
            accepting: after("3 seconds", ACCEPTING),
            resumed: after("1 second", REPLACEMENT),
          });
          yield* update.started;
          yield* TestClock.adjust("3 seconds");
          yield* update.resumeSubscribed;

          yield* TestClock.adjust("1 minute");
          expect(update.state()).toEqual(UNCOMMITTED_RESUME);
        }),
      ),
  );

  it.effect(
    "waits for this update's outcome when a reconnect lands between the baseline and the request",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const update = yield* launchUpdate({
            reconnectAfterBaseline: true,
            accepting: Stream.make(ACCEPTING),
            // The process that accepted the update over the new session replays its own ready first.
            resumed: after("1 second", ready("2026-08-01T00:01:00.000Z", "0.0.30")).pipe(
              Stream.concat(
                after(
                  "1 minute",
                  ready(
                    "2026-08-01T00:05:00.000Z",
                    "0.0.31",
                    committed("update-1", "0.0.30", "0.0.31"),
                  ),
                ),
              ),
            ),
          });
          yield* update.resumeSubscribed;

          yield* TestClock.adjust("1 second");
          expect(update.state()).toMatchObject({ status: "running", stage: "resuming" });
          yield* TestClock.adjust("1 minute");
          expect(update.state()).toMatchObject({ status: "idle" });
        }),
      ),
  );

  it.effect(
    "sends the update without a baseline when the accepting server never replays ready",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const update = yield* launchUpdate({
            accepting: Stream.never,
            resumed: after(
              "1 second",
              ready(
                "2026-08-01T00:05:00.000Z",
                "0.0.31",
                committed("update-1", "0.0.30", "0.0.31"),
              ),
            ),
          });
          yield* update.started;

          yield* TestClock.adjust("5 seconds");
          yield* TestClock.adjust("1 second");
          expect(update.state()).toMatchObject({ status: "idle" });
        }),
      ),
  );
});

describe("launcher update outcome validation", () => {
  it.effect("rejects a rollback outcome that belongs to another update", () =>
    Effect.gen(function* () {
      const result = {
        targetVersion: "0.0.31",
        method: "boot-service",
        updateId: "update-1",
      } as const;
      const foreign = {
        version: 1,
        sequence: 1,
        type: "ready",
        payload: {
          at: "2026-08-01T00:05:00.000Z",
          environment: { serverVersion: "0.0.30" },
          // A rollback the launcher reported for an update this client did not send.
          updateOutcome: {
            id: "manual-1",
            fromVersion: "0.0.31",
            targetVersion: "0.0.30",
            status: "rolled-back",
            reason: "prepared-timeout",
          } as ServerSelfUpdateOutcome,
        },
      };
      const failure = yield* Effect.flip(validateServerUpdateReadyEvent(result, foreign as never));
      expect(failure).toMatchObject({
        status: "failed",
        reason: "The service launcher resumed without committing the requested server version.",
      });
    }),
  );
});
