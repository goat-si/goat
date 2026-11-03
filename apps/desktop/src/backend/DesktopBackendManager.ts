import { closeRun, makeStopDeadline } from "./DesktopBackendStopDeadline.ts";
import {
  runBackendProcess,
  signalOfExitReason,
  DEFAULT_BACKEND_TERMINATE_GRACE,
  BACKEND_STOP_TIMEOUT,
  type DesktopBackendStartConfig,
  type PreflightFailure,
  writeBackendStopIntent,
  removeBackendStopIntent,
  waitForBackendStopIntent,
  recordBackendStopRequest,
  initialBackendManagerState,
  type ActiveBackendRun,
  type BackendManagerState,
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
import * as Deferred from "effect/Deferred";
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
  type DesktopStopReason,
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

export type BackendStopReason = DesktopStopReason;

export interface DesktopBackendInstance {
  readonly id: BackendInstanceId;
  readonly label: Effect.Effect<string>;
  readonly start: Effect.Effect<void>;
  readonly showRecovery?: Effect.Effect<void>;
  readonly stop: (
    reason: BackendStopReason,
    options?: { readonly timeout?: Duration.Duration },
  ) => Effect.Effect<void>;
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

const activePid = (active: Option.Option<ActiveBackendRun>): Option.Option<number> =>
  Option.flatMap(active, (run) => run.pid);

const withActiveRun =
  (runId: number, f: (run: ActiveBackendRun) => ActiveBackendRun) =>
  (state: BackendManagerState): BackendManagerState => ({
    ...state,
    active: Option.map(state.active, (run) => (run.id === runId ? f(run) : run)),
  });

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
  const state = yield* Ref.make(initialBackendManagerState);
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
        const spawnReady = yield* Deferred.make<void>();
        const boundedStop = yield* Ref.make(false);
        const intent = {
          requested: yield* Ref.make(false),
          written: yield* Deferred.make<void>(),
          settled: yield* Deferred.make<void>(),
        };
        if (config.value.bootstrap.desktopStopIntentPath === undefined) {
          yield* Deferred.succeed(intent.written, undefined);
          yield* Deferred.succeed(intent.settled, undefined);
        }
        const runId = yield* Ref.modify(state, (latest) => [
          latest.nextRunId,
          {
            ...latest,
            active: Option.some({
              id: latest.nextRunId,
              scope: runScope,
              spawnReady,
              intent,
              intentPath: config.value.bootstrap.desktopStopIntentPath,
              boundedStop,
              fiber: Option.none(),
              pid: Option.none(),
              exitObserved: false,
              stopRequested: false,
              stopRequest: Option.none(),
              exitAtNanos: Option.none(),
            } satisfies ActiveBackendRun),
            nextRunId: latest.nextRunId + 1,
          },
        ]);

        yield* backendOutputLog.beginSession({
          details: `pid=pending port=${config.value.bootstrap.port} cwd=${config.value.cwd}`,
        });
        controlRun = runId;
        recoveryStatus = "starting";
        let startedPid: number | undefined;
        let observedExit = false;
        const finalizeRun = Effect.fn("desktop.backendInstance.finalizeRun")(function* (
          reason: string,
          exitCode?: number,
        ) {
          const stateDirOwned = exitCode === SERVER_EXIT_CODE_STATE_DIR_OWNED;
          const databaseAhead = exitCode === SERVER_EXIT_CODE_DATABASE_AHEAD;
          yield* mutex.withPermits(1)(
            Effect.gen(function* () {
              const {
                isCurrentRun,
                nextState,
                pid,
                exitObserved,
                stopRequested,
                stopRequest,
                exitAtNanos,
                wasReady,
              } = yield* Ref.modify(
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
                    readonly stopRequest: ActiveBackendRun["stopRequest"];
                    readonly exitAtNanos: ActiveBackendRun["exitAtNanos"];
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
                        stopRequest: Option.none(),
                        exitAtNanos: Option.none(),
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
                      stopRequest: currentRun.stopRequest,
                      exitAtNanos: currentRun.exitAtNanos,
                      wasReady: latest.ready,
                    },
                    next,
                  ] as const;
                },
              );

              if (observedExit || startedPid === undefined)
                yield* Effect.forkDetach(
                  removeBackendStopIntent(
                    fileSystem,
                    config.value.bootstrap.desktopStopIntentPath,
                    intent,
                  ),
                );

              if (!isCurrentRun && observedExit && startedPid !== undefined) {
                const write = backendOutputLog.recordStop({
                  message: "late-spawned backend exited",
                  level: "WARN",
                  details: `pid=${startedPid} runId=${runId} exit=${reason}`,
                });
                if (yield* Ref.get(boundedStop)) yield* Effect.forkDetach(write);
                else yield* write;
              }
              if (isCurrentRun && !exitObserved && Option.isSome(pid)) {
                if (wasReady) yield* spec.onShutdown?.() ?? Effect.void;
                yield* pauseRecovery();
                return;
              }
              if (isCurrentRun) {
                yield* removeControlSource(runId);
                if (Option.isSome(pid)) {
                  const signal = signalOfExitReason(reason);
                  if (exitObserved && Option.isSome(stopRequest)) {
                    const elapsed = Option.match(exitAtNanos, {
                      onNone: () => "exit observation time unavailable",
                      onSome: (atNanos) =>
                        `exit observed ${Number((atNanos - stopRequest.value.atNanos) / 1_000_000n)}ms after the stop request`,
                    });
                    const details = `pid=${pid.value} ${reason} ${signal && signal !== "SIGTERM" ? "during" : "after"} stop reason=${stopRequest.value.reason}; ${elapsed}`;
                    if (signal && signal !== "SIGTERM") {
                      yield* backendOutputLog.persistFailure({
                        details: `${details} (the desktop sends SIGKILL if the server has not exited ${Duration.toMillis(DEFAULT_BACKEND_TERMINATE_GRACE)}ms after SIGTERM)`,
                      });
                    } else {
                      yield* backendOutputLog.persistStopOutput({ details });
                    }
                  } else if (exitObserved && !stopRequested) {
                    yield* backendOutputLog.persistFailure({
                      details: `pid=${pid.value} ${reason}${signal ? "; the desktop had not requested a stop" : ""}`,
                    });
                  } else {
                    yield* backendOutputLog.discardSession;
                  }
                }
                if (Option.isNone(pid)) yield* backendOutputLog.discardSession;
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
          onSpawnReady: Deferred.succeed(spawnReady, undefined).pipe(Effect.asVoid),
          onStarted: Effect.fn("desktop.backendInstance.onStarted")(function* (pid) {
            yield* mutex.withPermits(1)(
              Effect.gen(function* () {
                startedPid = pid;
                const activeBeforeStart = Option.getOrUndefined((yield* Ref.get(state)).active);
                if (activeBeforeStart?.id !== runId) {
                  const write = backendOutputLog.recordStop({
                    message: "backend spawned after its stop gave up; releasing it",
                    level: "WARN",
                    details: `pid=${pid} runId=${runId}`,
                  });
                  if (yield* Ref.get(boundedStop)) yield* Effect.forkDetach(write);
                  else yield* write;
                  return;
                }
                yield* updateActiveRun(runId, (run) => ({ ...run, pid: Option.some(pid) }));
                yield* startupFailure.reset;
                yield* backendOutputLog.beginSession({
                  details: `pid=${pid} port=${config.value.bootstrap.port} cwd=${config.value.cwd}`,
                  preserve: true,
                });
                const active = Option.getOrUndefined((yield* Ref.get(state)).active);
                if (active?.id === runId && active.stopRequested) {
                  yield* backendOutputLog.markStop;
                }
              }),
            );
          }),
          onExitObserved: Effect.fn("desktop.backendInstance.onExitObserved")(function* () {
            yield* mutex.withPermits(1)(
              Effect.gen(function* () {
                const exitAtNanos = yield* Clock.monotonicTimeNanos;
                observedExit = true;
                yield* updateActiveRun(runId, (run) => ({
                  ...run,
                  exitObserved: true,
                  exitAtNanos: Option.some(exitAtNanos),
                }));
              }),
            );
          }),
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
            Ref.get(state).pipe(
              Effect.flatMap((current) =>
                Option.getOrUndefined(current.active)?.id === runId
                  ? startupFailure
                      .append(streamName, chunk)
                      .pipe(Effect.andThen(backendOutputLog.writeOutputChunk(streamName, chunk)))
                  : Effect.void,
              ),
            ),
        }).pipe(
          Effect.ensuring(Deferred.succeed(spawnReady, undefined).pipe(Effect.asVoid)),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Scope.provide(runScope),
          Effect.matchEffect({
            onFailure: (error) => finalizeRun(error.message),
            onSuccess: (exit) => finalizeRun(exit.reason, Option.getOrUndefined(exit.code)),
          }),
          Effect.ensuring(
            waitForBackendStopIntent(intent).pipe(
              Effect.andThen(Scope.close(runScope, Exit.void)),
              Effect.ignore,
            ),
          ),
        );

        // A pending spawn must outlive instance teardown to release any late child.
        const fiber = yield* Effect.forkDetach(program);
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

  const stop: DesktopBackendInstance["stop"] = Effect.fn("desktop.backendInstance.stop")(function* (
    reason: BackendStopReason,
    options?: {
      readonly timeout?: Duration.Duration;
    },
  ) {
    const startedAt = yield* Clock.monotonicTimeNanos;
    const { remaining, reportTimeout } = yield* makeStopDeadline(
      startedAt,
      options?.timeout,
      backendOutputLog.recordStop,
    );
    recoveryStatus = "stopped";
    const locked = Effect.gen(function* () {
      const atNanos = yield* Clock.monotonicTimeNanos;
      const currentRun = Option.getOrUndefined((yield* Ref.get(state)).active);
      if (currentRun && !currentRun.exitObserved && !currentRun.stopRequested)
        yield* Ref.set(currentRun.intent.requested, true);
      const result = yield* Ref.modify(state, (latest) => {
        const active = Option.map(latest.active, (run) =>
          run.exitObserved || run.stopRequested
            ? run
            : { ...run, stopRequested: true, stopRequest: Option.some({ reason, atNanos }) },
        );
        return [
          {
            active,
            newStopRequest:
              Option.isSome(latest.active) &&
              !latest.active.value.exitObserved &&
              !latest.active.value.stopRequested,
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
      const run = Option.getOrUndefined(result.active);
      if (run && options?.timeout) yield* Ref.set(run.boundedStop, true);
      if (run && result.newStopRequest) {
        yield* Effect.forkDetach(
          writeBackendStopIntent(
            run,
            reason,
            fileSystem,
            backendOutputLog.recordStop,
            options?.timeout !== undefined,
          ),
        );
        yield* backendOutputLog.markStop;
      }
      return result;
    });
    const budget = options?.timeout ? yield* remaining(options.timeout) : undefined;
    const acquired = yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const permit = budget
          ? yield* restore(mutex.take(1)).pipe(Effect.timeoutOption(budget))
          : Option.some(yield* restore(mutex.take(1)));
        if (Option.isNone(permit)) return Option.none();
        return Option.some(yield* locked.pipe(Effect.ensuring(mutex.release(1))));
      }),
    );
    if (Option.isNone(acquired)) {
      yield* Ref.update(state, (latest) => ({ ...latest, desiredRunning: false }));
      yield* Effect.forkDetach(stop(reason));
      const waitedMs = Number(((yield* Clock.monotonicTimeNanos) - startedAt) / 1_000_000n);
      yield* reportTimeout(
        `reason=${reason} waitedMs=${waitedMs}; waiting for a backend start in progress`,
      );
      return;
    }
    const { active, restartFiber, notifyShutdown, newStopRequest } = acquired.value;
    const run = Option.getOrUndefined(active);
    if (run && newStopRequest) {
      yield* recordBackendStopRequest(
        run.pid,
        reason,
        options?.timeout,
        backendOutputLog.recordStop,
      );
    }

    const finish = Effect.gen(function* () {
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
          const waitStarted = yield* Clock.monotonicTimeNanos;
          const pendingWarning = backendOutputLog.recordStop({
            message: "backend spawn still pending at stop",
            level: "WARN",
            details: `pid=pending reason=${reason}`,
          });
          const closed = yield* closeRun(
            run,
            options?.timeout
              ? Effect.forkDetach(pendingWarning).pipe(Effect.asVoid)
              : pendingWarning,
            options?.timeout ? { timeout: yield* remaining(options.timeout) } : undefined,
          );
          if (!closed) {
            const waitedMs = Number(((yield* Clock.monotonicTimeNanos) - waitStarted) / 1_000_000n);
            yield* reportTimeout(
              `pid=${Option.match(run.pid, { onNone: () => "pending", onSome: String })} reason=${reason} waitedMs=${waitedMs}; the server may still be running`,
            );
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
    if (options?.timeout) {
      const finishing = yield* Effect.forkDetach(finish);
      const completed = yield* Fiber.await(finishing).pipe(
        Effect.timeoutOption(yield* remaining(options.timeout)),
      );
      if (Option.isNone(completed)) {
        const waitedMs = Number(((yield* Clock.monotonicTimeNanos) - startedAt) / 1_000_000n);
        yield* reportTimeout(
          `reason=${reason} waitedMs=${waitedMs}; the server may still be running`,
        );
      }
    } else {
      yield* finish;
    }
  });

  const waitForReady = makeBackendReadinessWait(snapshot);

  const retry: Effect.Effect<void> = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    if (Option.isSome(current.active)) {
      yield* stop("recovery-retry", { timeout: Duration.seconds(10) });
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
        stop: stop("recovery-stop", { timeout: Duration.seconds(10) }),
        logPath: Option.getOrUndefined(config)?.backendLogPath ?? "",
      }) ?? Effect.void
    );
  });
  yield* Effect.addFinalizer(() => stop("instance-closed", { timeout: BACKEND_STOP_TIMEOUT }));

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
