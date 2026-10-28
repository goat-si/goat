import {
  runBackendProcess,
  type DesktopBackendStartConfig,
  type PreflightFailure,
} from "./DesktopBackendProcess.ts";
export * from "./DesktopBackendProcess.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Path joining here is a pure platform operation.
import * as NodePath from "node:path";
import { restartDelayMs } from "./DesktopBackendRecoveryPolicy.ts";
import * as Clock from "effect/Clock";
import * as Random from "effect/Random";
import { makeRecoveryBudget } from "./DesktopBackendRecovery.ts";
import {
  makeStartupFailureReporter,
  makeBackendReadinessWait,
  type BackendStartupFailure,
} from "./DesktopBackendStartup.ts";
export type { BackendStartupFailure } from "./DesktopBackendStartup.ts";
import * as Brand from "effect/Brand";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import {
  SERVER_EXIT_CODE_DATABASE_AHEAD,
  SERVER_EXIT_CODE_STATE_DIR_OWNED,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@goat/contracts";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";

const STARTUP_FAILURE_RESTART_ATTEMPTS = 3;
const MAX_PREFLIGHT_FAILURE_ATTEMPTS = 5;
export interface DesktopBackendSnapshot {
  readonly desiredRunning: boolean;
  readonly ready: boolean;
  readonly activePid: Option.Option<number>;
  readonly restartAttempt: number;
  readonly restartScheduled: boolean;
  readonly recovery?:
    | "starting"
    | "running"
    | "blocked"
    | "backoff"
    | "crash-loop"
    | "record-unavailable"
    | "stopped";
}

export type BackendInstanceId = string & Brand.Brand<"BackendInstanceId">;
export const BackendInstanceId = Brand.nominal<BackendInstanceId>();

export const PRIMARY_INSTANCE_ID: BackendInstanceId = BackendInstanceId(
  PRIMARY_LOCAL_ENVIRONMENT_ID,
);

export interface DesktopBackendInstance {
  readonly id: BackendInstanceId;
  readonly label: Effect.Effect<string>;
  readonly start: Effect.Effect<void>;
  readonly showRecovery?: Effect.Effect<void>;
  readonly stop: (options?: { readonly timeout?: Duration.Duration }) => Effect.Effect<void>;
  readonly currentConfig: Effect.Effect<Option.Option<DesktopBackendStartConfig>>;
  readonly snapshot: Effect.Effect<DesktopBackendSnapshot>;
  readonly waitForReady: (timeout: Duration.Duration) => Effect.Effect<boolean>;
}

export interface BackendInstanceSpec {
  readonly id: BackendInstanceId;
  readonly label: Effect.Effect<string>;
  readonly configResolve: Effect.Effect<DesktopBackendStartConfig, PlatformError.PlatformError>;
  /** Receives the ready run's resolved URL; reading current config could race a subsequent restart. */
  readonly onReady?: (httpBaseUrl: URL) => Effect.Effect<void>;
  readonly onShutdown?: () => Effect.Effect<void>;
  readonly onPreflightFailed?: (failure: PreflightFailure) => Effect.Effect<boolean>;
  readonly onStateDirOwned?: () => Effect.Effect<void>;
  readonly onDatabaseAhead?: () => Effect.Effect<void>;
  readonly onStartupFailure?: (failure: BackendStartupFailure) => Effect.Effect<void>;
  readonly onRecoveryPaused?: (actions: {
    readonly label: string;
    readonly reason: string;
    readonly retry: Effect.Effect<void>;
    readonly stop: Effect.Effect<void>;
    readonly logPath: string;
  }) => Effect.Effect<void>;
}

interface ActiveBackendRun {
  readonly id: number;
  readonly scope: Scope.Closeable;
  readonly fiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly pid: Option.Option<number>;
  readonly exitObserved: boolean;
  readonly stopRequested: boolean;
}

interface BackendManagerState {
  readonly desiredRunning: boolean;
  readonly ready: boolean;
  readonly config: Option.Option<DesktopBackendStartConfig>;
  readonly active: Option.Option<ActiveBackendRun>;
  readonly restartAttempt: number;
  readonly startupRetryAttempt: number;
  readonly preflightFailureAttempt: number;
  readonly restartFiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly nextRunId: number;
}

const initialState: BackendManagerState = {
  desiredRunning: false,
  ready: false,
  config: Option.none(),
  active: Option.none(),
  restartAttempt: 0,
  startupRetryAttempt: 0,
  preflightFailureAttempt: 0,
  restartFiber: Option.none(),
  nextRunId: 1,
};

const activePid = (active: Option.Option<ActiveBackendRun>): Option.Option<number> =>
  Option.flatMap(active, (run) => run.pid);

const withActiveRun =
  (runId: number, f: (run: ActiveBackendRun) => ActiveBackendRun) =>
  (state: BackendManagerState): BackendManagerState => ({
    ...state,
    active: Option.map(state.active, (run) => (run.id === runId ? f(run) : run)),
  });

const closeRun = (
  run: ActiveBackendRun,
  parentScope: Scope.Scope,
  options?: { readonly timeout?: Duration.Duration },
): Effect.Effect<boolean> => {
  const waitForFiber = Option.match(run.fiber, {
    onNone: () => Effect.void,
    onSome: (fiber) => Fiber.await(fiber).pipe(Effect.asVoid),
  });
  const close = Scope.close(run.scope, Exit.void).pipe(Effect.andThen(waitForFiber));
  const timeout = options?.timeout;

  if (!timeout) {
    return close.pipe(Effect.as(true));
  }

  return Effect.forkIn(close, parentScope).pipe(
    Effect.flatMap((closeFiber) =>
      Fiber.await(closeFiber).pipe(Effect.timeoutOption(timeout), Effect.map(Option.isSome)),
    ),
  );
};

export const makeBackendInstance = Effect.fn("makeBackendInstance")(function* (
  spec: BackendInstanceSpec,
): Effect.fn.Return<
  DesktopBackendInstance,
  never,
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
  | DesktopObservability.DesktopBackendOutputLogFactory
  | DesktopTelemetryPublisher.DesktopTelemetryPublisher
  | DesktopBrowserHost.DesktopBrowserHost
  | DesktopWslEnvironment.DesktopWslEnvironment
  | Scope.Scope
> {
  const parentScope = yield* Scope.Scope;
  const fileSystem = yield* FileSystem.FileSystem;
  const backendOutputLogFactory = yield* DesktopObservability.DesktopBackendOutputLogFactory;
  const backendOutputLog = yield* backendOutputLogFactory.forInstance(spec.id);
  const desktopTelemetryPublisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
  const desktopBrowserHost = yield* DesktopBrowserHost.DesktopBrowserHost;
  const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const state = yield* Ref.make(initialState);
  const mutex = yield* Semaphore.make(1);
  const startupFailure = yield* makeStartupFailureReporter(spec.onStartupFailure);
  const recovery = yield* makeRecoveryBudget();

  const { logWarning: logInstanceWarning, logError: logInstanceError } =
    DesktopObservability.makeComponentLogger(`desktop-backend-instance:${spec.id}`);

  const updateActiveRun = (runId: number, f: (run: ActiveBackendRun) => ActiveBackendRun) =>
    Ref.update(state, withActiveRun(runId, f));

  let recoveryStatus: NonNullable<DesktopBackendSnapshot["recovery"]> = "stopped";
  let controlRun = 0;
  const snapshot = Ref.get(state).pipe(
    Effect.map((current): DesktopBackendSnapshot => ({
      desiredRunning: current.desiredRunning,
      ready: current.ready,
      activePid: activePid(current.active),
      restartAttempt: current.restartAttempt,
      restartScheduled: Option.isSome(current.restartFiber),
      recovery: recoveryStatus,
    })),
  );
  const currentConfig = Ref.get(state).pipe(Effect.map((current) => current.config));
  let lastRemovedControlRun = 0;
  const removeControlSource = Effect.fn("desktop.backendInstance.removeControlSource")(function* (
    runId: number,
  ) {
    if (runId <= lastRemovedControlRun || runId !== controlRun) return;
    lastRemovedControlRun = runId;
    yield* desktopTelemetryPublisher.removeControlSource(spec.id);
  });

  const pauseRecovery = Effect.fn("desktop.backendInstance.pauseRecovery")(function* () {
    recoveryStatus = "blocked";
    const wasReady = yield* Ref.modify(
      state,
      (current) => [current.ready, { ...current, ready: false, desiredRunning: false }] as const,
    );
    if (wasReady) yield* spec.onShutdown?.() ?? Effect.void;
    yield* recovery.pause("blocked");
    yield* Effect.forkIn(showRecovery, parentScope);
  });

  const cancelRestart = Effect.gen(function* () {
    const restartFiber = yield* Ref.modify(state, (current) => [
      current.restartFiber,
      {
        ...current,
        restartFiber: Option.none(),
      },
    ]);

    yield* Option.match(restartFiber, {
      onNone: () => Effect.void,
      onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    });
  });

  const start: Effect.Effect<void> = Effect.suspend(() =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (Option.isSome(current.active)) {
          if ((yield* recovery.current).pause !== null) return;
          if (!current.desiredRunning) {
            yield* Ref.update(state, (latest) => ({
              ...latest,
              desiredRunning: true,
            }));
          }
          return;
        }

        if (current.ready) {
          yield* spec.onShutdown?.() ?? Effect.void;
          yield* Ref.update(state, (latest) =>
            latest.ready ? { ...latest, ready: false } : latest,
          );
        }
        const config = yield* spec.configResolve.pipe(
          Effect.tapError((error) =>
            logInstanceError("failed to generate desktop backend configuration", {
              cause: error.message,
            }),
          ),
          Effect.option,
        );
        if (Option.isNone(config)) {
          if (current.desiredRunning) {
            yield* scheduleRestart("failed to generate desktop backend configuration");
          }
          return;
        }
        yield* Ref.update(state, (latest) => ({ ...latest, config: Option.some(config.value) }));
        yield* recovery.initialize(
          config.value.recoveryStateDirectory === undefined
            ? undefined
            : NodePath.join(
                config.value.recoveryStateDirectory,
                `${encodeURIComponent(spec.id)}.json`,
              ),
        );
        if ((yield* recovery.current).pause !== null) {
          recoveryStatus = (yield* recovery.current).pause ?? "blocked";
          yield* Ref.update(state, (latest) => ({ ...latest, desiredRunning: false }));
          yield* Effect.forkIn(showRecovery, parentScope);
          return;
        }
        const entryExists = yield* fileSystem
          .exists(config.value.entryPath)
          .pipe(Effect.orElseSucceed(() => false));

        const resetFatalPreflightCounter =
          !current.desiredRunning && current.preflightFailureAttempt > 0;
        yield* cancelRestart;
        yield* Ref.update(state, (latest) => ({
          ...latest,
          desiredRunning: true,
          ready: false,
          config: Option.some(config.value),
          preflightFailureAttempt: resetFatalPreflightCounter ? 0 : latest.preflightFailureAttempt,
        }));

        const preflightFailure = config.value.preflightFailure;
        if (Option.isSome(preflightFailure)) {
          const { reason, fatal, retryLimit } = preflightFailure.value;
          if (!fatal && retryLimit === undefined) {
            yield* Ref.update(state, (latest) =>
              latest.preflightFailureAttempt === 0
                ? latest
                : { ...latest, preflightFailureAttempt: 0 },
            );
            yield* scheduleRestart(reason);
            return;
          }
          const attemptLimit = retryLimit ?? MAX_PREFLIGHT_FAILURE_ATTEMPTS;
          const attempt = yield* Ref.modify(state, (latest) => {
            const next = latest.preflightFailureAttempt + 1;
            return [next, { ...latest, preflightFailureAttempt: next }] as const;
          });
          if (attempt > attemptLimit) {
            yield* logInstanceError("backend preflight still failing after fallback; stopping", {
              reason,
              attempt,
            });
            yield* Ref.update(state, (latest) => ({
              ...latest,
              desiredRunning: false,
              ready: false,
            }));
            return;
          }
          if (attempt === attemptLimit) {
            yield* logInstanceError(
              "backend preflight failed repeatedly; surfacing and falling back",
              { reason, attempt },
            );
            const shouldRestart = yield* (
              spec.onPreflightFailed?.(preflightFailure.value) ?? Effect.succeed(false)
            );
            if (shouldRestart) {
              yield* scheduleRestart(reason);
            } else {
              yield* Ref.update(state, (latest) => ({
                ...latest,
                desiredRunning: false,
                ready: false,
              }));
            }
            return;
          }
          yield* scheduleRestart(reason);
          return;
        }
        yield* Ref.update(state, (latest) =>
          latest.preflightFailureAttempt === 0 ? latest : { ...latest, preflightFailureAttempt: 0 },
        );

        if (!entryExists) {
          yield* scheduleRestart(`missing server entry at ${config.value.entryPath}`);
          return;
        }

        const runScope = yield* Scope.make("sequential");
        const runId = yield* Ref.modify(state, (latest) => [
          latest.nextRunId,
          {
            ...latest,
            active: Option.some({
              id: latest.nextRunId,
              scope: runScope,
              fiber: Option.none(),
              pid: Option.none(),
              exitObserved: false,
              stopRequested: false,
            } satisfies ActiveBackendRun),
            nextRunId: latest.nextRunId + 1,
          },
        ]);

        controlRun = runId;
        recoveryStatus = "starting";
        const finalizeRun = Effect.fn("desktop.backendInstance.finalizeRun")(function* (
          reason: string,
          exitCode?: number,
        ) {
          const stateDirOwned = exitCode === SERVER_EXIT_CODE_STATE_DIR_OWNED;
          const databaseAhead = exitCode === SERVER_EXIT_CODE_DATABASE_AHEAD;
          yield* mutex.withPermits(1)(
            Effect.gen(function* () {
              const { isCurrentRun, nextState, pid, exitObserved, stopRequested, wasReady } =
                yield* Ref.modify(
                  state,
                  (
                    latest,
                  ): readonly [
                    {
                      readonly isCurrentRun: boolean;
                      readonly nextState: BackendManagerState;
                      readonly pid: Option.Option<number>;
                      readonly exitObserved: boolean;
                      readonly stopRequested: boolean;
                      readonly wasReady: boolean;
                    },
                    BackendManagerState,
                  ] => {
                    const currentRun = Option.getOrUndefined(latest.active);
                    if (currentRun?.id !== runId) {
                      return [
                        {
                          isCurrentRun: false,
                          nextState: latest,
                          pid: Option.none<number>(),
                          exitObserved: false,
                          stopRequested: false,
                          wasReady: false,
                        },
                        latest,
                      ] as const;
                    }

                    const next = {
                      ...latest,
                      active:
                        !currentRun.exitObserved && Option.isSome(currentRun.pid)
                          ? latest.active
                          : Option.none<ActiveBackendRun>(),
                      ready: false,
                    };
                    return [
                      {
                        isCurrentRun: true,
                        nextState: next,
                        pid: currentRun.pid,
                        exitObserved: currentRun.exitObserved,
                        stopRequested: currentRun.stopRequested,
                        wasReady: latest.ready,
                      },
                      next,
                    ] as const;
                  },
                );

              if (isCurrentRun && !exitObserved && Option.isSome(pid)) {
                if (wasReady) yield* spec.onShutdown?.() ?? Effect.void;
                yield* pauseRecovery();
                return;
              }
              if (isCurrentRun) {
                yield* removeControlSource(runId);
                if (Option.isSome(pid)) {
                  if (exitObserved && !stopRequested) {
                    yield* backendOutputLog.persistFailure({
                      details: `pid=${pid.value} ${reason}`,
                    });
                  } else {
                    yield* backendOutputLog.discardSession;
                  }
                }
                if (wasReady) {
                  yield* spec.onShutdown?.() ?? Effect.void;
                }
              }

              if (isCurrentRun && nextState.desiredRunning) {
                if (stateDirOwned && !stopRequested) {
                  yield* Ref.update(state, (latest) => ({ ...latest, desiredRunning: false }));
                  yield* (spec.onStateDirOwned?.() ?? Effect.void).pipe(Effect.ignore);
                  return;
                }
                if (databaseAhead && !stopRequested) {
                  yield* Ref.update(state, (latest) => ({ ...latest, desiredRunning: false }));
                  yield* (spec.onDatabaseAhead?.() ?? Effect.void).pipe(Effect.ignore);
                  return;
                }
                yield* scheduleRestart(reason, true);
              }
            }),
          );
        });

        const program = runBackendProcess({
          ...config.value,
          desktopTelemetryStream: Stream.unwrap(
            Ref.get(state).pipe(
              Effect.map((current) =>
                Option.getOrUndefined(current.active)?.id === runId
                  ? desktopTelemetryPublisher.encodedForSource(spec.id)
                  : Stream.empty,
              ),
            ),
          ),
          onControlFailure: removeControlSource(runId),
          desktopBrowserStream: desktopBrowserHost.events,
          onDesktopBrowserCommand: desktopBrowserHost.handleCommandLine,
          onDesktopTelemetryControl: Effect.fn("desktop.backendInstance.onDesktopTelemetryControl")(
            function* (message) {
              const current = yield* Ref.get(state);
              const active = Option.getOrUndefined(current.active);
              if (active?.id !== runId || active.stopRequested || !current.desiredRunning) return;
              yield* desktopTelemetryPublisher.handleControlForSource(spec.id, message);
            },
          ),
          onStarted: Effect.fn("desktop.backendInstance.onStarted")(function* (pid) {
            yield* updateActiveRun(runId, (run) => ({
              ...run,
              pid: Option.some(pid),
            }));
            yield* startupFailure.reset;
            yield* backendOutputLog.beginSession({
              details: `pid=${pid} port=${config.value.bootstrap.port} cwd=${config.value.cwd}`,
            });
          }),
          onExitObserved: () =>
            updateActiveRun(runId, (run) => ({
              ...run,
              exitObserved: true,
            })),
          onReady: Effect.fn("desktop.backendInstance.onReady")(function* () {
            const isCurrentRun = yield* Ref.modify(state, (latest) => {
              const activeRun = Option.getOrUndefined(latest.active);
              if (
                activeRun?.id !== runId ||
                activeRun.stopRequested ||
                !latest.desiredRunning ||
                recoveryStatus === "blocked"
              ) {
                return [false, latest] as const;
              }

              return [
                true,
                {
                  ...latest,
                  ready: true,
                  startupRetryAttempt: 0,
                },
              ] as const;
            });
            if (!isCurrentRun) {
              return;
            }

            recoveryStatus = "running";
            yield* Effect.sleep("10 minutes").pipe(
              Effect.andThen(
                mutex.withPermits(1)(
                  Effect.gen(function* () {
                    const current = yield* Ref.get(state);
                    const active = Option.getOrUndefined(current.active);
                    if (
                      active?.id !== runId ||
                      active.stopRequested ||
                      !current.ready ||
                      !current.desiredRunning
                    )
                      return;
                    if (!(yield* recovery.reset)) {
                      recoveryStatus = "record-unavailable";
                      yield* logInstanceError(
                        "could not reset recovery state; automatic restarts disabled",
                      );
                      yield* Effect.forkIn(showRecovery, parentScope);
                      return;
                    }
                    yield* Ref.update(state, (latest) => ({ ...latest, restartAttempt: 0 }));
                  }),
                ),
              ),
              Effect.forkIn(runScope),
            );
            yield* spec.onReady?.(config.value.httpBaseUrl) ?? Effect.void;
            if (
              config.value.runningDistro !== undefined &&
              config.value.wslRuntimeId !== undefined
            ) {
              yield* wslEnvironment.pruneRuntimes(
                config.value.runningDistro,
                config.value.wslRuntimeId,
              );
            }
          }),
          onReadinessFailure: Effect.fn("desktop.backendInstance.onReadinessFailure")(
            function* (error) {
              yield* logInstanceWarning("backend readiness check failed during bootstrap", {
                error: error.message,
              });
              yield* backendOutputLog.persistFailureSnapshot({
                details: error.message,
              });
              yield* startupFailure.report("The server started but did not become ready in time.");
            },
          ),
          onOutput: (streamName, chunk) =>
            startupFailure
              .append(streamName, chunk)
              .pipe(Effect.andThen(backendOutputLog.writeOutputChunk(streamName, chunk))),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Scope.provide(runScope),
          Effect.matchEffect({
            onFailure: (error) => finalizeRun(error.message),
            onSuccess: (exit) => finalizeRun(exit.reason, Option.getOrUndefined(exit.code)),
          }),
          Effect.ensuring(Scope.close(runScope, Exit.void).pipe(Effect.ignore)),
        );

        const fiber = yield* Effect.forkIn(program, parentScope);
        yield* updateActiveRun(runId, (run) => ({
          ...run,
          fiber: Option.some(fiber),
        }));
      }),
    ),
  ).pipe(Effect.withSpan("desktop.backendInstance.start", { attributes: { id: spec.id } }));

  const scheduleRestart = Effect.fn("desktop.backendInstance.scheduleRestart")(function* (
    reason: string,
    afterExit = false,
  ) {
    const current = yield* Ref.get(state);
    if (!current.desiredRunning || Option.isSome(current.restartFiber)) return;
    const record = yield* afterExit
      ? recovery.fail(yield* Clock.currentTimeMillis, String(current.nextRunId - 1), reason)
      : recovery.current;
    if (record.pause !== null) {
      recoveryStatus = record.pause;
      yield* Ref.update(state, (latest) => ({ ...latest, desiredRunning: false, ready: false }));
      yield* Effect.forkIn(showRecovery, parentScope);
      return;
    }
    const attempt = afterExit ? record.attempt : current.startupRetryAttempt + 1;
    const delay = Duration.millis(restartDelayMs(attempt - 1, yield* Random.next));
    recoveryStatus = "backoff";
    const scheduled = Option.some(delay);
    yield* Ref.update(state, (latest) => ({
      ...latest,
      restartAttempt: record.attempt,
      startupRetryAttempt: afterExit ? latest.startupRetryAttempt : attempt,
    }));

    yield* Option.match(scheduled, {
      onNone: () => Effect.void,
      onSome: Effect.fn("desktop.backendInstance.scheduleRestartFiber")(function* (delay) {
        yield* logInstanceError("backend retry scheduled", {
          reason,
          delayMs: Duration.toMillis(delay),
        });
        if (attempt >= STARTUP_FAILURE_RESTART_ATTEMPTS) {
          yield* startupFailure.report(`The server could not start (${reason}).`);
        }
        const restartFiber = yield* Effect.forkIn(
          Effect.sleep(delay).pipe(
            Effect.andThen(
              Ref.modify(state, (latest) => {
                const shouldRestart = latest.desiredRunning;
                return [
                  shouldRestart,
                  {
                    ...latest,
                    restartFiber: Option.none(),
                  },
                ] as const;
              }),
            ),
            Effect.flatMap((shouldRestart) => (shouldRestart ? start : Effect.void)),
            Effect.catchCause((cause) =>
              logInstanceError("desktop backend restart fiber failed", {
                cause: Cause.pretty(cause),
              }),
            ),
          ),
          parentScope,
        );
        yield* Ref.update(state, (latest) =>
          Option.isNone(latest.restartFiber)
            ? {
                ...latest,
                restartFiber: Option.some(restartFiber),
              }
            : latest,
        );
      }),
    });
  });

  const stop = Effect.fn("desktop.backendInstance.stop")(function* (options?: {
    readonly timeout?: Duration.Duration;
  }) {
    recoveryStatus = "stopped";
    const { active, restartFiber, notifyShutdown } = yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const result = yield* Ref.modify(state, (latest) => {
          const active = Option.map(latest.active, (run) =>
            run.exitObserved ? run : { ...run, stopRequested: true },
          );
          return [
            {
              active,
              restartFiber: latest.restartFiber,
              notifyShutdown: latest.ready,
            },
            {
              ...latest,
              desiredRunning: false,
              ready: false,
              active,
              restartFiber: Option.none<Fiber.Fiber<void, never>>(),
            },
          ] as const;
        });
        return result;
      }),
    );

    if (notifyShutdown) {
      yield* (spec.onShutdown?.() ?? Effect.void).pipe(Effect.ignore);
    }
    yield* Option.match(restartFiber, {
      onNone: () => Effect.void,
      onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    });
    yield* Option.match(active, {
      onNone: () => Effect.void,
      // The enclosing operation owns the span for this inline handler.
      onSome: Effect.fnUntraced(function* (run) {
        const closed = yield* closeRun(run, parentScope, options);
        if (!closed) {
          return;
        }
        const cleanup = yield* mutex.withPermits(1)(
          Ref.modify(
            state,
            (
              latest,
            ): readonly [
              {
                readonly needsCleanup: boolean;
                readonly shouldStart: boolean;
              },
              BackendManagerState,
            ] => {
              const current = Option.getOrUndefined(latest.active);
              if (current?.id !== run.id) {
                return [
                  {
                    needsCleanup: false,
                    shouldStart:
                      latest.desiredRunning &&
                      Option.isNone(latest.active) &&
                      Option.isNone(latest.restartFiber),
                  },
                  latest,
                ];
              }
              if (Option.isSome(current.pid) && !current.exitObserved) {
                return [{ needsCleanup: false, shouldStart: false }, latest];
              }
              return [
                {
                  needsCleanup: true,
                  shouldStart: latest.desiredRunning,
                },
                {
                  ...latest,
                  active: Option.none<ActiveBackendRun>(),
                },
              ];
            },
          ),
        );
        if (cleanup.needsCleanup) {
          yield* removeControlSource(run.id);
          yield* backendOutputLog.discardSession;
        }
        if (cleanup.shouldStart) {
          yield* start;
        }
      }),
    });
  });

  const waitForReady = makeBackendReadinessWait(snapshot);

  const retry: Effect.Effect<void> = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    if (Option.isSome(current.active)) {
      yield* stop({ timeout: Duration.seconds(10) });
      if (Option.isSome((yield* Ref.get(state)).active)) return;
    }
    if (yield* recovery.reset) {
      yield* Ref.update(state, (latest) => ({ ...latest, restartAttempt: 0 }));
      yield* start;
    } else yield* Effect.forkIn(showRecovery, parentScope);
  });
  const showRecovery: Effect.Effect<void> = Effect.gen(function* () {
    const record = yield* recovery.current;
    if (record.pause === null) return;
    const config = yield* currentConfig;
    yield* (
      spec.onRecoveryPaused?.({
        label: yield* spec.label,
        reason: record.pause,
        retry,
        stop: stop({ timeout: Duration.seconds(10) }),
        logPath: Option.getOrUndefined(config)?.backendLogPath ?? "",
      }) ?? Effect.void
    );
  });
  yield* Effect.addFinalizer(() => stop());

  return {
    id: spec.id,
    label: spec.label,
    start,
    showRecovery,
    stop,
    currentConfig,
    snapshot,
    waitForReady,
  } satisfies DesktopBackendInstance;
});
