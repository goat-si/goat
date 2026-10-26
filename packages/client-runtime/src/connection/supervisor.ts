import type { DesktopSshPreparationProgress } from "@goat/contracts";
import { withRelayClientTracing } from "@goat/shared/relayTracing";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Tracer from "effect/Tracer";

import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  type ConnectionAttemptError,
  type ConnectionFailure,
  type ConnectionFailureOrigin,
  type ConnectionSshPreparation,
  type ConnectionSshRuntimeReady,
  type ConnectionTarget,
  ConnectionTransientError,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as RpcSession from "../rpc/session.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import { isLoopbackEntry, loopbackBudget, loopbackBudgetMs, retryDelayMs } from "./loopbackHost.ts";
import {
  connectionRouteId,
  connectionRouteKind,
  connectionRoutes,
  entryWithRoutes,
  type ReportedEndpoint,
} from "./routes.ts";

let supervisorInstanceSequence = 0;

const SETUP_TIMEOUT_FLOOR_MS = 15_000;
const SETUP_TIMEOUT_CAP_MS = 45_000;
const SSH_PREPARATION_TIMEOUT_MS = 900_000;
const SETUP_SAMPLE_COUNT = 5;
const SETUP_HEADROOM = 1.5;
const synchronizationTimeout = Duration.fromInputUnsafe("75 seconds");
const CONNECTION_PROBE_TIMEOUT = "15 seconds";
const QUICK_CONNECTION_PROBE_TIMEOUT = "3 seconds";
const BACKOFF_RESET_AFTER_MS = 30_000;
const WAKE_RETRY_WINDOW_MS = 30_000;
const WAKE_RETRY_DELAY_MS = 2_000;
const LOCAL_PROXY_RECHECK_MS = 60_000;
const BETTER_ROUTE_CHECK_INTERVAL = "60 seconds";
// A better route that answered the check but then failed to connect is not
// tried again for this long, so a flaky LAN cannot bounce the connection.
const BETTER_ROUTE_COOLDOWN_MS = 300_000;

interface SupervisorIntent {
  readonly desired: boolean;
  readonly network: NetworkStatus;
}

type SupervisorSignal =
  | { readonly _tag: "ConnectRequested" }
  | { readonly _tag: "DisconnectRequested" }
  | { readonly _tag: "RetryRequested" }
  | { readonly _tag: "NetworkChanged"; readonly network: NetworkStatus }
  | { readonly _tag: "Wakeup"; readonly reason: ConnectionWakeups.ConnectionWakeup }
  | { readonly _tag: "BetterRouteAvailable"; readonly routeId: string };

type QueuedSupervisorSignal = SupervisorSignal & { readonly attemptSequence: number };

interface PendingRetryTrace {
  readonly previousAttempt: Tracer.Span;
  readonly failureCount: number;
  readonly delayMs: number;
  readonly reason: ConnectionFailure["reason"];
}

interface TracedAttemptFailure {
  readonly error: ConnectionAttemptError;
  readonly attemptSpan: Option.Option<Tracer.Span>;
}

type AttemptOutcome =
  | {
      readonly _tag: "Interrupted";
      readonly established: boolean;
      readonly stable: boolean;
      readonly resetRetry: boolean;
    }
  | {
      readonly _tag: "Failure";
      readonly established: boolean;
      readonly stable: boolean;
      readonly failure: TracedAttemptFailure & { readonly error: ConnectionFailure };
      readonly slowSetupTimeout?: SetupPreparation;
      readonly failureOrigin?: ConnectionFailureOrigin;
    };

interface SetupPreparation {
  readonly routeId: string | undefined;
  readonly startedAt: bigint;
}

interface EstablishmentProgress {
  readonly preparation: SetupPreparation;
  readonly pendingPreparations: ReadonlyMap<string, bigint>;
  readonly synchronizedRoutes: number;
  readonly hostAnswered: boolean;
  readonly setup: { readonly routeId: string; readonly elapsedMs: number } | null;
  readonly stage: "preparing" | "opening" | "synchronizing";
  readonly ordinaryStartedAt: bigint;
  readonly sshPreparation: {
    readonly operationId: string;
    readonly deadline: bigint;
    readonly phase: ConnectionSshPreparation["phase"];
    readonly hostAnswered: boolean;
  } | null;
  readonly wake: Queue.Queue<void>;
}

type EstablishmentEvent =
  | {
      readonly _tag: "Completed";
      readonly exit: Exit.Exit<
        {
          readonly attemptSpan: Option.Option<Tracer.Span>;
          readonly lease: ConnectionDriver.EnvironmentConnectionLease;
        },
        TracedAttemptFailure
      >;
    }
  | { readonly _tag: "Interrupted"; readonly resetRetry: boolean }
  | { readonly _tag: "TimedOut"; readonly sshPreparationTimedOut: boolean };

function exitUnlessInterrupted<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Exit.Exit<A, E>, never, R> {
  return Effect.matchCauseEffect(effect, {
    onFailure: (cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(Exit.failCause(cause)),
    onSuccess: (value) => Effect.succeed(Exit.succeed(value)),
  });
}

export interface EnvironmentSupervisorOptions {
  readonly initiallyDesired?: boolean;
  readonly learnRoutes?: (input: {
    readonly activeRoute: ConnectionRoute;
    readonly reported: ReadonlyArray<ReportedEndpoint>;
  }) => Effect.Effect<Option.Option<ConnectionCatalogEntry>>;
}

export { retryDelayMs };

function annotateTarget(target: ConnectionTarget) {
  return Effect.annotateCurrentSpan({
    "environment.id": target.environmentId,
    "environment.label": target.label,
    "environment.target.kind": target._tag,
  });
}

function availableState(intent: SupervisorIntent, generation: number): SupervisorConnectionState {
  return {
    desired: false,
    network: intent.network,
    phase: "available",
    stage: null,
    attempt: 0,
    generation,
    lastFailure: null,
    retryAt: null,
  };
}

function offlineState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionFailure | null,
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "offline",
    stage: null,
    attempt,
    generation,
    lastFailure,
    retryAt: null,
  };
}

function connectingState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionFailure | null,
  stage: SupervisorConnectionState["stage"] = "preparing",
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "connecting",
    stage,
    attempt,
    generation,
    lastFailure,
    retryAt: null,
  };
}

function failureFromExit<A>(
  target: ConnectionTarget,
  exit: Exit.Exit<A, TracedAttemptFailure>,
  established: boolean,
  stable: boolean,
): AttemptOutcome {
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
    return { _tag: "Interrupted", established, stable, resetRetry: false };
  }
  const typedFailure = exit.cause.reasons.find(Cause.isFailReason);
  if (typedFailure) {
    if (typedFailure.error.error._tag === "ConnectionAttemptSuperseded") {
      return { _tag: "Interrupted", established, stable, resetRetry: false };
    }
    return {
      _tag: "Failure",
      established,
      stable,
      failure: { ...typedFailure.error, error: typedFailure.error.error },
    };
  }
  return {
    _tag: "Failure",
    established,
    stable,
    failure: {
      error: new ConnectionTransientError({
        reason: "transport",
        detail: `${target.label} connection failed unexpectedly.`,
      }),
      attemptSpan: Option.none(),
    },
  };
}

export class EnvironmentSupervisor extends Context.Service<
  EnvironmentSupervisor,
  {
    readonly target: ConnectionTarget;
    readonly state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>;
    readonly session: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession.RpcSession>>;
    readonly prepared: SubscriptionRef.SubscriptionRef<Option.Option<PreparedConnection>>;
    readonly connect: Effect.Effect<void>;
    readonly disconnect: Effect.Effect<void>;
    readonly retryNow: Effect.Effect<void>;
  }
>()("@goat/client-runtime/connection/supervisor/EnvironmentSupervisor") {}

export const make = Effect.fn("EnvironmentSupervisor.make")(function* (
  entry: ConnectionCatalogEntry,
  options?: EnvironmentSupervisorOptions,
): Effect.fn.Return<
  EnvironmentSupervisor["Service"],
  never,
  | Connectivity.Connectivity
  | ConnectionDriver.ConnectionDriver
  | Scope.Scope
  | ConnectionWakeups.ConnectionWakeups
> {
  const target = entry.target;
  const loopback = isLoopbackEntry(entry);
  const usesRelay = connectionRoutes(entry).some(
    (route) => route.target._tag === "RelayConnectionTarget",
  );
  const setupTimeoutDetail = `${target.label} did not respond during connection setup.${
    usesRelay ? ` ${NETWORK_BLOCKING_HINT}` : ""
  }`;
  yield* annotateTarget(target);

  const connectivity = yield* Connectivity.Connectivity;
  const driver = yield* ConnectionDriver.ConnectionDriver;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const initialIntent: SupervisorIntent = {
    desired: options?.initiallyDesired ?? false,
    network: yield* connectivity.status,
  };
  const intent = yield* Ref.make(initialIntent);
  const attemptSequence = yield* Ref.make(0);
  const supervisorId = `${yield* Random.nextInt}:${yield* Random.nextInt}:${++supervisorInstanceSequence}`;
  const evidence = yield* Ref.make<{
    readonly failureOrigin?: ConnectionFailureOrigin;
    readonly sshPreparation?: ConnectionSshPreparation;
    readonly sshRuntimeReady?: ConnectionSshRuntimeReady;
  }>({});
  // Rejoining or retrying the same native operation cannot renew its lifetime.
  const preparations = new Map<
    string,
    { readonly operationId: string; readonly deadline?: bigint; readonly ended: boolean }
  >();
  const signals = yield* Queue.unbounded<QueuedSupervisorSignal>();
  const resetRetryState = yield* Ref.make(false);
  const probeUnanswered = yield* Ref.make(false);
  // Cancellation consumes its signal; suspension must still gate later queued requests.
  const suspended = yield* Ref.make(false);
  const wakeRetryUntil = yield* Ref.make(0n);
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(
    !initialIntent.desired
      ? availableState(initialIntent, 0)
      : initialIntent.network === "offline"
        ? offlineState(initialIntent, 0, 0, null)
        : connectingState(initialIntent, 0, 1, null),
  );
  const session = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(Option.none());
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  // Learned routes arrive while a session is live, so the route list is read
  // fresh by each attempt and check instead of being fixed at creation.
  const currentEntry = yield* Ref.make(entry);
  const currentRoutes = Ref.get(currentEntry).pipe(Effect.map(connectionRoutes));
  const preferredRouteId = yield* Ref.make(Option.none<string>());
  const routeCooldowns = yield* Ref.make<ReadonlyMap<string, bigint>>(new Map());
  const setupSamples = yield* Ref.make<ReadonlyArray<number>>([]);

  const attemptEntry = Effect.gen(function* () {
    const latest = yield* Ref.get(currentEntry);
    const routes = connectionRoutes(latest);
    const preferred = yield* Ref.getAndSet(preferredRouteId, Option.none());
    if (Option.isNone(preferred)) return latest;
    const route = routes.find(
      (candidate) => connectionRouteId(candidate.target) === preferred.value,
    );
    return route === undefined
      ? latest
      : entryWithRoutes(latest, [route, ...routes.filter((candidate) => candidate !== route)]);
  });

  const learnRoutesFrom = Effect.fnUntraced(function* (
    learn: NonNullable<EnvironmentSupervisorOptions["learnRoutes"]>,
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) {
    const config = yield* lease.session.initialConfig.pipe(Effect.option);
    const reported = Option.getOrUndefined(config)?.directEndpoints;
    if (reported === undefined) return;
    const activeId = connectionRouteId(lease.prepared.target);
    const activeRoute = (yield* currentRoutes).find(
      (route) => connectionRouteId(route.target) === activeId,
    );
    if (activeRoute === undefined) return;
    const updated = yield* learn({ activeRoute, reported });
    if (Option.isSome(updated)) {
      yield* Ref.set(currentEntry, updated.value);
      yield* requestBetterRouteCheck(lease);
    }
  });

  const routeIndex = (lease: ConnectionDriver.EnvironmentConnectionLease) =>
    currentRoutes.pipe(
      Effect.map((routes) =>
        routes.findIndex(
          (route) => connectionRouteId(route.target) === connectionRouteId(lease.prepared.target),
        ),
      ),
    );

  const checkBetterRoutes = Effect.fnUntraced(function* (
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) {
    const latest = yield* Ref.get(currentEntry);
    const current = yield* routeIndex(lease);
    if (current <= 0) return;
    const now = yield* Clock.monotonicTimeNanos;
    const cooldowns = yield* Ref.get(routeCooldowns);
    const better = connectionRoutes(latest)
      .slice(0, current)
      .filter((route) => (cooldowns.get(connectionRouteId(route.target)) ?? 0n) <= now);
    const passed = yield* Effect.forEach(
      better,
      (route: ConnectionRoute) => driver.preflight(latest, route),
      { concurrency: "unbounded" },
    );
    const index = passed.indexOf(true);
    if (index === -1) return;
    const live = yield* SubscriptionRef.get(session);
    if (Option.isNone(live) || live.value !== lease.session) return;
    yield* signal({
      _tag: "BetterRouteAvailable",
      routeId: connectionRouteId(better[index]!.target),
    });
  });

  const betterRouteChecks = yield* Queue.dropping<ConnectionDriver.EnvironmentConnectionLease>(1);
  const requestBetterRouteCheck = (lease: ConnectionDriver.EnvironmentConnectionLease) =>
    routeIndex(lease).pipe(
      Effect.flatMap((index) =>
        index > 0 ? Queue.offer(betterRouteChecks, lease).pipe(Effect.asVoid) : Effect.void,
      ),
    );

  const clearLease = Effect.all(
    [SubscriptionRef.set(session, Option.none()), SubscriptionRef.set(prepared, Option.none())],
    { discard: true },
  );

  const setState = Effect.fn("EnvironmentSupervisor.setState")(function* (
    next: SupervisorConnectionState,
  ) {
    yield* SubscriptionRef.set(state, { ...next, ...(yield* Ref.get(evidence)) });
  });

  const signal = Effect.fn("EnvironmentSupervisor.signal")(function* (next: SupervisorSignal) {
    if (
      next._tag === "ConnectRequested" ||
      next._tag === "RetryRequested" ||
      (next._tag === "NetworkChanged" && next.network === "online")
    ) {
      yield* Ref.set(suspended, false);
    }
    if (next._tag === "DisconnectRequested") {
      yield* Ref.set(wakeRetryUntil, 0n);
    }
    if (next._tag === "Wakeup") {
      if (next.reason === "suspend") {
        yield* Ref.set(suspended, true);
      } else if (
        next.reason !== "credentials-changed" &&
        (next.reason !== "network-changed" || (yield* Ref.get(intent)).network === "online")
      ) {
        yield* Ref.set(suspended, false);
      }
      if (next.reason === "application-active-reconnect") {
        yield* Ref.set(
          wakeRetryUntil,
          (yield* Clock.monotonicTimeNanos) + BigInt(WAKE_RETRY_WINDOW_MS) * 1_000_000n,
        );
      }
    }
    // Delayed signals may target an attempt that their replacement already superseded.
    const targetedAttempt = yield* Ref.get(attemptSequence);
    yield* Queue.offer(signals, { ...next, attemptSequence: targetedAttempt });
  });

  const logManagedRelayAccountChange = Effect.logInfo(
    "Managed relay account changed; restarting the environment connection.",
  ).pipe(
    Effect.annotateLogs({
      "environment.id": target.environmentId,
      "environment.label": target.label,
    }),
  );

  const reportProgress = Effect.fn("EnvironmentSupervisor.reportProgress")(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionFailure | null,
    attemptActive: Ref.Ref<boolean>,
    progress: ConnectionDriver.ConnectionDriverProgress,
  ) {
    if (!(yield* Ref.get(attemptActive)) || !(yield* Ref.get(intent)).desired) return;
    if ("prepared" in progress) {
      yield* SubscriptionRef.set(prepared, Option.some(progress.prepared));
    }
    const current = yield* SubscriptionRef.get(state);
    // A local dependency may still be down; a background check must not flash "connecting".
    if (
      current.phase === "blocked" &&
      current.lastFailure?._tag === "ConnectionBlockedError" &&
      current.lastFailure.localProxyUnavailable === true
    )
      return;
    yield* setState(
      connectingState(yield* Ref.get(intent), generation, attempt, lastFailure, progress.stage),
    );
  });

  const establishConnection = Effect.fnUntraced(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionFailure | null,
    establishmentProgress: Ref.Ref<EstablishmentProgress>,
    attemptActive: Ref.Ref<boolean>,
  ) {
    const sequence = yield* Ref.get(attemptSequence);
    const terminalReports = new Map<string, DesktopSshPreparationProgress["outcome"]>();
    return yield* driver.connect(
      yield* attemptEntry,
      (progress) =>
        Effect.gen(function* () {
          if (!(yield* Ref.get(attemptActive)) || (yield* Ref.get(attemptSequence)) !== sequence)
            return;
          const now = yield* Clock.monotonicTimeNanos;
          const current = yield* Ref.get(establishmentProgress);
          const routeId =
            progress.stage === "preparing"
              ? progress.routeId
              : connectionRouteId(progress.prepared.target);
          const native = progress.stage === "preparing" ? progress.sshPreparation : undefined;
          const routeChanged = routeId !== undefined && routeId !== current.preparation.routeId;
          // Only the driver's plain route-start report can change routes. Late SSH callbacks cannot.
          if (
            routeChanged &&
            progress.stage === "preparing" &&
            (native !== undefined || progress.hostAnswered)
          )
            return;
          const recorded = routeId === undefined ? undefined : preparations.get(routeId);
          const preparation = recorded?.operationId === native?.operationId ? recorded : undefined;
          const terminal =
            native === undefined ? undefined : terminalReports.get(native.operationId);
          if (
            native !== undefined &&
            (native.phase !== null
              ? preparation?.ended === true || terminal !== undefined
              : terminal !== undefined &&
                !(
                  terminal === "ready" &&
                  recorded?.operationId === native.operationId &&
                  (native.outcome === "superseded" || native.outcome === "failed")
                ))
          )
            return;
          const identity =
            routeId === undefined ? undefined : { supervisorId, attemptId: sequence, routeId };
          let next: EstablishmentProgress = {
            ...current,
            stage: progress.stage,
            preparation: routeChanged
              ? { routeId, startedAt: current.pendingPreparations.get(routeId!) ?? now }
              : current.preparation,
            hostAnswered:
              (routeChanged ? false : current.hostAnswered) ||
              progress.stage !== "preparing" ||
              (progress.stage === "preparing" &&
                (progress.hostAnswered === true || native?.hostAnswered === true)),
            sshPreparation: routeChanged ? null : current.sshPreparation,
            synchronizedRoutes:
              current.synchronizedRoutes + (progress.stage === "synchronizing" ? 1 : 0),
          };
          let visible = yield* Ref.get(evidence);
          if (routeChanged) {
            const { sshPreparation: _preparation, sshRuntimeReady: _ready, ...rest } = visible;
            visible = rest;
          }
          if (native !== undefined && identity !== undefined) {
            if (
              current.sshPreparation !== null &&
              current.sshPreparation.operationId !== native.operationId
            )
              return;
            if (native.phase !== null) {
              const candidate =
                now + BigInt(Math.min(SSH_PREPARATION_TIMEOUT_MS, native.remainingMs)) * 1_000_000n;
              const previous = preparation?.deadline;
              const deadline =
                previous === undefined || candidate < previous ? candidate : previous;
              preparations.set(identity.routeId, {
                operationId: native.operationId,
                deadline,
                ended: false,
              });
              next = {
                ...next,
                sshPreparation: {
                  operationId: native.operationId,
                  phase: native.phase,
                  hostAnswered: native.hostAnswered,
                  deadline,
                },
              };
              visible = {
                ...visible,
                sshPreparation: {
                  ...identity,
                  operationId: native.operationId,
                  phase: native.phase,
                  hostAnswered: native.hostAnswered,
                },
              };
            } else {
              terminalReports.set(native.operationId, native.outcome);
              preparations.set(identity.routeId, {
                ...preparation,
                operationId: native.operationId,
                ended: true,
              });
              const { sshPreparation: _preparation, sshRuntimeReady: _ready, ...rest } = visible;
              visible = rest;
              // Pairing and socket opening start with their ordinary allowance after installation ends.
              next = {
                ...next,
                sshPreparation: null,
                ...(terminal === undefined
                  ? {
                      ordinaryStartedAt: now,
                      preparation: { routeId, startedAt: now },
                      setup: null,
                    }
                  : {}),
              };
              if (
                native.outcome === "ready" &&
                native.attachmentId !== undefined &&
                native.runtimeStatus !== undefined
              ) {
                visible = {
                  ...visible,
                  sshRuntimeReady: {
                    ...identity,
                    operationId: native.operationId,
                    attachmentId: native.attachmentId,
                    runtimeStatus: native.runtimeStatus,
                  },
                };
              }
            }
          }
          if (progress.stage !== "preparing") {
            const { sshPreparation: _preparation, ...rest } = visible;
            visible = rest;
            if (next.sshPreparation !== null) {
              if (routeId !== undefined) {
                preparations.set(routeId, {
                  operationId: next.sshPreparation.operationId,
                  deadline: next.sshPreparation.deadline,
                  ended: true,
                });
              }
              next = {
                ...next,
                sshPreparation: null,
                ordinaryStartedAt: now,
                preparation: { routeId, startedAt: now },
              };
            }
          }
          if (progress.stage === "synchronizing") {
            next = {
              ...next,
              setup: {
                routeId: connectionRouteId(progress.prepared.target),
                elapsedMs: Number(now - next.preparation.startedAt) / 1_000_000,
              },
            };
          }
          yield* Ref.set(evidence, visible);
          yield* Ref.set(establishmentProgress, next);
          yield* Queue.offer(next.wake, undefined);
          yield* reportProgress(attempt, generation, lastFailure, attemptActive, progress);
        }),
      { supervisorId, attemptId: sequence },
    );
  });

  // Low-cardinality dimensions for time-to-connected dashboards; the error
  // detail stays in the span status, never in an attribute.
  const annotateAttemptOutcome = Effect.fnUntraced(function* (
    exit: Exit.Exit<ConnectionDriver.EnvironmentConnectionLease, ConnectionAttemptError>,
  ) {
    if (Exit.isSuccess(exit)) {
      const leaseTarget = exit.value.prepared.target;
      const route = (yield* currentRoutes).find(
        (candidate) => connectionRouteId(candidate.target) === connectionRouteId(leaseTarget),
      );
      return yield* Effect.annotateCurrentSpan({
        "connection.outcome": "connected",
        "connection.route": connectionRouteKind(
          route ?? { target: leaseTarget, profile: Option.none() },
        ),
      });
    }
    if (Cause.hasInterruptsOnly(exit.cause)) {
      return yield* Effect.annotateCurrentSpan("connection.outcome", "interrupted");
    }
    const failure = exit.cause.reasons.find(Cause.isFailReason)?.error;
    yield* Effect.annotateCurrentSpan({
      "connection.outcome": "failed",
      "connection.failure.tag": failure?._tag ?? "defect",
      "connection.failure.reason": failure?.reason ?? "defect",
    });
  });

  const traceRelayEstablishment = (
    effect: Effect.Effect<
      ConnectionDriver.EnvironmentConnectionLease,
      ConnectionAttemptError,
      Scope.Scope
    >,
    attempt: number,
    generation: number,
    pendingRetry: Option.Option<PendingRetryTrace>,
  ) => {
    // The span must end with the ConnectionAttemptError itself: the exporter
    // can only describe an Error-like failure, and a TracedAttemptFailure
    // wrapper reached it as "[object Object]". The wrapper is added outside.
    let attemptSpan = Option.none<Tracer.Span>();
    const traced = Effect.gen(function* () {
      attemptSpan = Option.some(yield* Effect.currentSpan.pipe(Effect.orDie));
      yield* annotateTarget(target);
      yield* Effect.annotateCurrentSpan({
        "connection.attempt": attempt,
        "connection.generation": generation,
        "connection.retry.failure_count": Option.match(pendingRetry, {
          onNone: () => 0,
          onSome: (retry) => retry.failureCount,
        }),
      });
      return yield* effect.pipe(Effect.onExit(annotateAttemptOutcome));
    }).pipe(Effect.withSpan("relay.connection.attempt", { root: true }));

    return Option.match(pendingRetry, {
      onNone: () => traced,
      onSome: (retry) =>
        traced.pipe(
          Effect.linkSpans(retry.previousAttempt, {
            "connection.retry.delay_ms": retry.delayMs,
            "connection.retry.reason": retry.reason,
          }),
        ),
    }).pipe(
      Effect.map((lease) => ({ attemptSpan, lease })),
      Effect.mapError((error): TracedAttemptFailure => ({ error, attemptSpan })),
      withRelayClientTracing,
    );
  };

  const establishTracedConnection = Effect.fnUntraced(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionFailure | null,
    pendingRetry: Option.Option<PendingRetryTrace>,
    establishmentProgress: Ref.Ref<EstablishmentProgress>,
    attemptActive: Ref.Ref<boolean>,
  ) {
    if (usesRelay) {
      return yield* traceRelayEstablishment(
        establishConnection(attempt, generation, lastFailure, establishmentProgress, attemptActive),
        attempt,
        generation,
        pendingRetry,
      );
    }
    return yield* establishConnection(
      attempt,
      generation,
      lastFailure,
      establishmentProgress,
      attemptActive,
    ).pipe(
      Effect.map((lease) => ({
        attemptSpan: Option.none<Tracer.Span>(),
        lease,
      })),
      Effect.mapError((error): TracedAttemptFailure => ({
        error,
        attemptSpan: Option.none(),
      })),
    );
  });

  const waitForEstablishmentInterrupt = Effect.fnUntraced(function* (
    ignoreOffline: Ref.Ref<boolean>,
    sequence: number,
  ) {
    for (;;) {
      const next = yield* Queue.take(signals);
      switch (next._tag) {
        case "DisconnectRequested":
          return false;
        case "RetryRequested":
          yield* Ref.set(resetRetryState, true);
          if (next.attemptSequence === sequence) return false;
          break;
        case "NetworkChanged":
          if (next.network === "offline" && !(yield* Ref.get(ignoreOffline))) {
            return false;
          }
          break;
        case "ConnectRequested":
        case "BetterRouteAvailable":
          break;
        case "Wakeup":
          if (next.reason === "suspend") return false;
          if (ConnectionWakeups.resetsRetryBackoff(next.reason)) {
            yield* Ref.set(resetRetryState, true);
          }
          if (next.reason === "application-active-reconnect") {
            if (next.attemptSequence === sequence) return true;
            yield* Ref.set(ignoreOffline, true);
          }
          if (next.reason === "credentials-changed" && usesRelay) {
            yield* logManagedRelayAccountChange;
            return false;
          }
          break;
      }
    }
  });

  const isRelayLease = (lease: ConnectionDriver.EnvironmentConnectionLease) =>
    lease.prepared.target._tag === "RelayConnectionTarget";

  const connectedLeaseEnd = Effect.fnUntraced(function* (
    next: SupervisorSignal,
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) {
    if (next._tag === "DisconnectRequested") {
      return "end" as const;
    }
    if (next._tag === "BetterRouteAvailable") {
      yield* Ref.set(preferredRouteId, Option.some(next.routeId));
      return "reset" as const;
    }
    if (next._tag !== "Wakeup") {
      return undefined;
    }
    if (next.reason === "application-active-reconnect") {
      // Mobile operating systems often kill a suspended socket without a close
      // event. A probe would show a dead socket as "Resuming" until it times
      // out, so a long background resume replaces the session at once.
      return "reset" as const;
    }
    // Only a session over GOAT Connect holds the old account's credential.
    if (next.reason === "credentials-changed" && isRelayLease(lease)) {
      yield* logManagedRelayAccountChange;
      return "end" as const;
    }
    return undefined;
  });

  const probeTimeoutFor = (next: SupervisorSignal): Duration.Input | undefined => {
    switch (next._tag) {
      case "RetryRequested":
        return QUICK_CONNECTION_PROBE_TIMEOUT;
      case "NetworkChanged":
        return next.network === "offline" ? QUICK_CONNECTION_PROBE_TIMEOUT : undefined;
      case "Wakeup":
        if (next.reason === "application-active") {
          return CONNECTION_PROBE_TIMEOUT;
        }
        return next.reason === "application-active-probe" || next.reason === "network-changed"
          ? QUICK_CONNECTION_PROBE_TIMEOUT
          : undefined;
      case "ConnectRequested":
      case "DisconnectRequested":
      case "BetterRouteAvailable":
        return undefined;
    }
  };

  // Returning to the app, an explicit retry, and the network reporting offline
  // all probe the live session instead of replacing it, so a healthy socket is
  // not torn down (the offline report is often wrong, for example for a
  // loopback server).
  const monitorConnectedLease = Effect.fnUntraced(function* (
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) {
    // A probe answers an explicit retry here, so the retry must not also reset
    // the backoff of a later, unrelated failure.
    const takeSignal = Queue.take(signals).pipe(
      Effect.tap((next) =>
        next._tag === "RetryRequested" ? Ref.set(resetRetryState, false) : Effect.void,
      ),
    );
    // Ticks always run: the check skips the preferred route itself, and the
    // route list can grow while connected (learned routes).
    yield* Stream.tick(BETTER_ROUTE_CHECK_INTERVAL).pipe(
      Stream.drop(1),
      Stream.runForEach(() => requestBetterRouteCheck(lease)),
      Effect.forkScoped,
    );
    for (;;) {
      const next = yield* takeSignal;
      const end = yield* connectedLeaseEnd(next, lease);
      if (end !== undefined) {
        return end === "reset";
      }
      if (
        (next._tag === "NetworkChanged" && next.network !== "offline") ||
        (next._tag === "Wakeup" && ConnectionWakeups.resetsRetryBackoff(next.reason))
      ) {
        yield* requestBetterRouteCheck(lease);
      }
      const probeTimeout = probeTimeoutFor(next);
      if (probeTimeout === undefined) {
        continue;
      }
      yield* Ref.set(probeUnanswered, true);
      const probe = yield* Effect.forkChild(lease.session.probe);
      let deadline =
        (yield* Clock.monotonicTimeNanos) +
        Duration.toNanosUnsafe(loopbackBudget(loopback, probeTimeout));
      for (;;) {
        const remaining = deadline - (yield* Clock.monotonicTimeNanos);
        const probeEvent = yield* Effect.raceAllFirst([
          Fiber.await(probe).pipe(
            Effect.map((exit) => ({ _tag: "ProbeCompleted" as const, exit })),
          ),
          takeSignal.pipe(Effect.map((signal) => ({ _tag: "Signal" as const, signal }))),
          Effect.sleep(Duration.nanos(remaining > 0n ? remaining : 0n)).pipe(
            Effect.as({ _tag: "TimedOut" as const }),
          ),
        ]);
        if (probeEvent._tag === "TimedOut") {
          yield* Fiber.interrupt(probe);
          return yield* new ConnectionTransientError({
            reason: "timeout",
            detail: `${target.label} did not respond to a connection health check.`,
          });
        }
        if (probeEvent._tag === "ProbeCompleted") {
          if (Exit.isSuccess(probeEvent.exit)) {
            yield* Ref.set(probeUnanswered, false);
          }
          yield* probeEvent.exit;
          break;
        }
        const endDuringProbe = yield* connectedLeaseEnd(probeEvent.signal, lease);
        if (endDuringProbe !== undefined) {
          yield* Fiber.interrupt(probe);
          return endDuringProbe === "reset";
        }
        const signalTimeout = probeTimeoutFor(probeEvent.signal);
        if (signalTimeout !== undefined) {
          const signalDeadline =
            (yield* Clock.monotonicTimeNanos) +
            Duration.toNanosUnsafe(loopbackBudget(loopback, signalTimeout));
          if (signalDeadline < deadline) deadline = signalDeadline;
        }
      }
    }
  });

  const runAttempt = Effect.fnUntraced(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionFailure | null,
    pendingRetry: Option.Option<PendingRetryTrace>,
    ignoreOffline: boolean,
    setupContinuation: SetupPreparation | undefined,
  ) {
    const sequence = yield* Ref.updateAndGet(attemptSequence, (current) => current + 1);
    const routes = new Set((yield* currentRoutes).map((route) => connectionRouteId(route.target)));
    for (const routeId of preparations.keys()) {
      if (!routes.has(routeId)) preparations.delete(routeId);
    }
    const ignoreOfflineState = yield* Ref.make(ignoreOffline);
    const attemptActive = yield* Ref.make(true);
    const switchingTo = yield* Ref.get(preferredRouteId);
    yield* SubscriptionRef.set(prepared, Option.none());
    const startedAt = yield* Clock.monotonicTimeNanos;
    const establishmentProgress = yield* Ref.make<EstablishmentProgress>({
      preparation: setupContinuation ?? { routeId: undefined, startedAt },
      // Earlier failed routes must not overwrite the still-pending fallback's start.
      pendingPreparations: new Map(
        setupContinuation?.routeId === undefined
          ? []
          : [[setupContinuation.routeId, setupContinuation.startedAt]],
      ),
      synchronizedRoutes: 0,
      hostAnswered: false,
      setup: null,
      stage: "preparing",
      ordinaryStartedAt: startedAt,
      sshPreparation: null,
      wake: yield* Queue.sliding<void>(1),
    });
    const setupBudgetMs = Math.min(
      SETUP_TIMEOUT_CAP_MS,
      Math.max(
        SETUP_TIMEOUT_FLOOR_MS,
        SETUP_HEADROOM * Math.max(0, ...(yield* Ref.get(setupSamples))),
      ),
    );
    const establishment = yield* Effect.raceAllFirst([
      exitUnlessInterrupted(
        establishTracedConnection(
          attempt,
          generation,
          lastFailure,
          pendingRetry,
          establishmentProgress,
          attemptActive,
        ).pipe(Effect.ensuring(Ref.set(attemptActive, false))),
      ).pipe(
        Effect.map((exit): EstablishmentEvent => ({
          _tag: "Completed",
          exit,
        })),
      ),
      waitForEstablishmentInterrupt(ignoreOfflineState, sequence).pipe(
        Effect.map((resetRetry): EstablishmentEvent => ({
          _tag: "Interrupted",
          resetRetry,
        })),
      ),
      // Each route may use the full setup time before the next is tried, and
      // each route that reaches synchronizing adds its own snapshot budget, so
      // a route that fails late does not eat the next route's time.
      Effect.gen(function* () {
        const routeCount = connectionRoutes(yield* Ref.get(currentEntry)).length;
        while (true) {
          const progress = yield* Ref.get(establishmentProgress);
          // Slow successes say nothing about an attempt whose host has not answered yet.
          const answered = progress.hostAnswered ? setupBudgetMs : SETUP_TIMEOUT_FLOOR_MS;
          const setup = Duration.toNanosUnsafe(
            Duration.millis(loopbackBudgetMs(loopback, answered) * routeCount),
          );
          const synchronized = BigInt(progress.synchronizedRoutes);
          const active = progress.sshPreparation;
          const preparing = active !== null && active.hostAnswered && active.phase !== "connecting";
          const deadline = preparing
            ? active.deadline
            : progress.ordinaryStartedAt +
              setup +
              synchronized * Duration.toNanosUnsafe(synchronizationTimeout);
          const remaining = deadline - (yield* Clock.monotonicTimeNanos);
          if (remaining <= 0n) {
            return {
              _tag: "TimedOut",
              sshPreparationTimedOut: preparing,
            } as const satisfies EstablishmentEvent;
          }
          yield* Effect.raceFirst(
            Effect.sleep(Duration.nanos(remaining)),
            Queue.take(progress.wake),
          );
        }
      }),
    ]);

    if (establishment._tag === "Interrupted") {
      return {
        _tag: "Interrupted",
        established: false,
        stable: false,
        resetRetry: establishment.resetRetry,
      } satisfies AttemptOutcome;
    }
    const failedProgress = yield* Ref.get(establishmentProgress);
    const failedOrigin =
      failedProgress.preparation.routeId === undefined
        ? undefined
        : {
            supervisorId,
            attemptId: sequence,
            routeId: failedProgress.preparation.routeId,
            stage: failedProgress.stage,
            setupTimeout: false,
          };
    if (establishment._tag === "TimedOut") {
      const progress = failedProgress;
      yield* Ref.update(evidence, ({ sshPreparation: _preparation, ...current }) => current);
      return {
        _tag: "Failure",
        established: false,
        stable: false,
        ...(failedOrigin === undefined
          ? {}
          : { failureOrigin: { ...failedOrigin, setupTimeout: true } }),
        ...(progress.hostAnswered &&
        progress.synchronizedRoutes === 0 &&
        !establishment.sshPreparationTimedOut
          ? { slowSetupTimeout: progress.preparation }
          : {}),
        failure: {
          error: new ConnectionTransientError({
            reason: "timeout",
            detail: establishment.sshPreparationTimedOut
              ? "SSH runtime preparation exceeded its 15-minute limit."
              : setupTimeoutDetail,
            ...(establishment.sshPreparationTimedOut ? { sshPreparationTimedOut: true } : {}),
          }),
          attemptSpan: Option.none(),
        },
      } satisfies AttemptOutcome;
    }
    if (Exit.isFailure(establishment.exit)) {
      const isUnexpectedDefect =
        !Cause.hasInterruptsOnly(establishment.exit.cause) &&
        !establishment.exit.cause.reasons.some(Cause.isFailReason);
      const outcome = failureFromExit(target, establishment.exit, false, false);
      yield* Ref.update(
        evidence,
        ({ sshPreparation: _preparation, sshRuntimeReady, ...current }) => ({
          ...current,
          ...(outcome._tag === "Failure" &&
          outcome.failure.error._tag === "ConnectionTransientError" &&
          outcome.failure.error.sshPreparationTimedOut !== true &&
          sshRuntimeReady !== undefined
            ? { sshRuntimeReady }
            : {}),
        }),
      );
      if (isUnexpectedDefect) {
        const defect = establishment.exit.cause.reasons.find(Cause.isDieReason)?.defect;
        yield* Effect.logError("Connection attempt failed with an unexpected defect.").pipe(
          Effect.annotateLogs({
            "environment.id": target.environmentId,
            "environment.label": target.label,
            "cause.reason_count": establishment.exit.cause.reasons.length,
            ...safeErrorLogAttributes(defect),
          }),
        );
      }
      return outcome._tag !== "Failure" || failedOrigin === undefined
        ? outcome
        : {
            ...outcome,
            failureOrigin: {
              ...failedOrigin,
              setupTimeout:
                outcome.failure.error._tag === "ConnectionTransientError" &&
                outcome.failure.error.sshPreparationTimedOut === true,
            },
          };
    }

    const active = establishment.exit.value;
    if (Option.isSome(switchingTo)) {
      const landed = connectionRouteId(active.lease.prepared.target);
      if (landed !== switchingTo.value) {
        const until =
          (yield* Clock.monotonicTimeNanos) + BigInt(BETTER_ROUTE_COOLDOWN_MS) * 1_000_000n;
        yield* Ref.update(routeCooldowns, (current) =>
          new Map(current).set(switchingTo.value, until),
        );
      }
    }
    const currentIntent = yield* Ref.get(intent);
    if (
      !currentIntent.desired ||
      (currentIntent.network === "offline" && !(yield* Ref.get(ignoreOfflineState)))
    ) {
      return {
        _tag: "Interrupted",
        established: false,
        stable: false,
        resetRetry: false,
      } satisfies AttemptOutcome;
    }

    const progress = yield* Ref.get(establishmentProgress);
    const setup = progress.setup;
    // Exclude the successful route's snapshot wait from future setup budgets.
    const setupElapsedMs =
      setup?.routeId === connectionRouteId(active.lease.prepared.target)
        ? setup.elapsedMs
        : Number((yield* Clock.monotonicTimeNanos) - progress.preparation.startedAt) / 1_000_000;
    yield* Ref.update(setupSamples, (samples) =>
      [...samples, setupElapsedMs].slice(-SETUP_SAMPLE_COUNT),
    );
    yield* Ref.set(wakeRetryUntil, 0n);
    const connectedAt = yield* Clock.currentTimeMillis;
    yield* Queue.clear(betterRouteChecks);
    yield* Queue.take(betterRouteChecks).pipe(
      Effect.flatMap(checkBetterRoutes),
      Effect.forever,
      Effect.ensuring(Queue.clear(betterRouteChecks).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
    yield* SubscriptionRef.set(prepared, Option.some(active.lease.prepared));
    yield* SubscriptionRef.set(session, Option.some(active.lease.session));
    if (options?.learnRoutes !== undefined) {
      yield* learnRoutesFrom(options.learnRoutes, active.lease).pipe(Effect.forkScoped);
    }
    yield* Ref.update(
      evidence,
      ({ failureOrigin: _origin, sshPreparation: _preparation, ...current }) => current,
    );
    yield* setState({
      desired: true,
      network: currentIntent.network,
      phase: "connected",
      stage: null,
      attempt,
      generation,
      lastFailure: null,
      retryAt: null,
    });

    yield* Effect.sleep(BACKOFF_RESET_AFTER_MS).pipe(
      Effect.andThen(SubscriptionRef.update(state, (current) => ({ ...current, attempt: 1 }))),
      Effect.forkScoped,
    );

    const connectedExit = yield* Effect.raceFirst(
      active.lease.session.closed.pipe(
        Effect.mapError((error): TracedAttemptFailure => ({
          error,
          attemptSpan: active.attemptSpan,
        })),
      ),
      monitorConnectedLease(active.lease).pipe(
        Effect.mapError((error): TracedAttemptFailure => ({
          error,
          attemptSpan: active.attemptSpan,
        })),
      ),
    ).pipe(exitUnlessInterrupted);
    const connectedForMs = (yield* Clock.currentTimeMillis) - connectedAt;
    if (Exit.isSuccess(connectedExit)) {
      return {
        _tag: "Interrupted",
        established: true,
        stable: connectedForMs >= BACKOFF_RESET_AFTER_MS,
        resetRetry: connectedExit.value,
      } satisfies AttemptOutcome;
    }
    const outcome = failureFromExit(
      target,
      connectedExit,
      true,
      connectedForMs >= BACKOFF_RESET_AFTER_MS,
    );
    if (outcome._tag === "Failure") {
      yield* Effect.void.pipe(
        Effect.withSpan("EnvironmentSupervisor.connectionLost", {
          root: true,
          attributes: {
            "environment.id": target.environmentId,
            "environment.label": target.label,
            "environment.target.kind": target._tag,
            "connection.connected_ms": connectedForMs,
            "connection.failure.reason": outcome.failure.error.reason,
            "connection.failure.detail": outcome.failure.error.detail,
          },
        }),
      );
    }
    return outcome;
  }, Effect.ensuring(clearLease));

  const waitForRetrySignal = Effect.fnUntraced(function* (delayMs: number) {
    // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off - the sleep is the retry delay, not a timeout around the signal loop
    return yield* Effect.raceFirst(
      Effect.sleep(delayMs).pipe(Effect.as(undefined)),
      Effect.gen(function* () {
        for (;;) {
          const next = yield* Queue.take(signals);
          switch (next._tag) {
            case "Wakeup":
            case "ConnectRequested":
            case "DisconnectRequested":
            case "RetryRequested":
            case "NetworkChanged":
              return next;
            case "BetterRouteAvailable":
              break;
          }
        }
      }),
    );
  });

  const waitForSignal = Queue.take(signals).pipe(
    Effect.repeat({ while: (next) => next._tag === "BetterRouteAvailable" }),
  );

  const run = Effect.fnUntraced(function* () {
    let failureCount = 0;
    let previousSlowSetupTimeout = false;
    let setupContinuation: SetupPreparation | undefined;
    let generation = 0;
    let latestFailure: ConnectionFailure | null = null;
    let pendingRetry = Option.none<PendingRetryTrace>();
    const resetRetryLadder = () => {
      failureCount = 0;
      pendingRetry = Option.none();
    };
    let replacing = false;
    const handleSignal = (next: SupervisorSignal | undefined) => {
      if (next?._tag === "Wakeup") {
        if (ConnectionWakeups.resetsRetryBackoff(next.reason)) resetRetryLadder();
        if (next.reason === "application-active-reconnect") replacing = true;
      }
    };

    for (;;) {
      const pendingSignals = yield* Queue.clear(signals);
      for (const next of pendingSignals) {
        handleSignal(next);
      }
      if (yield* Ref.getAndSet(resetRetryState, false)) {
        failureCount = 0;
        latestFailure = null;
        pendingRetry = Option.none();
      }
      const currentIntent = yield* Ref.get(intent);
      if (!currentIntent.desired) {
        previousSlowSetupTimeout = false;
        setupContinuation = undefined;
        resetRetryLadder();
        latestFailure = null;
        replacing = false;
        yield* clearLease;
        yield* Ref.set(evidence, {});
        yield* setState(availableState(currentIntent, generation));
        handleSignal(yield* waitForSignal);
        continue;
      }
      if (yield* Ref.get(suspended)) {
        yield* clearLease;
        yield* setState(offlineState(currentIntent, generation, failureCount + 1, latestFailure));
        handleSignal(yield* waitForSignal);
        continue;
      }
      if (currentIntent.network === "offline" && !replacing) {
        yield* clearLease;
        yield* setState(offlineState(currentIntent, generation, failureCount + 1, latestFailure));
        handleSignal(yield* waitForSignal);
        continue;
      }

      const attempt = failureCount + 1;
      const nextGeneration = generation + 1;
      const outcome: AttemptOutcome = yield* Effect.scoped(
        runAttempt(
          attempt,
          nextGeneration,
          latestFailure,
          pendingRetry,
          replacing,
          setupContinuation,
        ),
      );
      replacing = false;
      setupContinuation = undefined;
      const failedProbe = yield* Ref.getAndSet(probeUnanswered, false);
      if (yield* Ref.getAndSet(resetRetryState, false)) resetRetryLadder();
      if (outcome.established) {
        previousSlowSetupTimeout = false;
        generation = nextGeneration;
        // A session came up, so no earlier failure describes the connection.
        // Losing a live session is not a failed connection either, for example
        // a socket the OS killed while the app was suspended: its replacement
        // reports no failure until it fails itself.
        latestFailure = null;
        if (outcome.stable) {
          resetRetryLadder();
        }
      }
      if (outcome._tag === "Interrupted") {
        if (outcome.resetRetry) {
          resetRetryLadder();
          replacing = true;
        }
        continue;
      }

      if (yield* Ref.get(suspended)) continue;

      const slowSetupTimeout = outcome.slowSetupTimeout !== undefined;
      const retrySlowSetup = slowSetupTimeout && !previousSlowSetupTimeout;
      previousSlowSetupTimeout = slowSetupTimeout;
      // Counted retries can still join the same preparation; retain its full cost.
      setupContinuation = outcome.slowSetupTimeout;
      // Retry once without penalizing a host that already answered.
      if (retrySlowSetup) continue;

      const attemptSpan: Option.Option<Tracer.Span> = outcome.failure.attemptSpan;
      const error: ConnectionFailure = outcome.failure.error;
      if (!outcome.established) {
        latestFailure = error;
        yield* Ref.update(evidence, ({ failureOrigin: _origin, ...current }) => ({
          ...current,
          ...(outcome.failureOrigin === undefined ? {} : { failureOrigin: outcome.failureOrigin }),
        }));
      }
      if (error._tag === "ConnectionBlockedError") {
        const blockedIntent = yield* Ref.get(intent);
        yield* setState({
          desired: blockedIntent.desired,
          network: blockedIntent.network,
          phase: "blocked",
          stage: null,
          attempt: failureCount + 1,
          generation,
          lastFailure: error,
          retryAt: null,
        });
        const blockedWait =
          error.reason === "configuration" && error.localProxyUnavailable === true
            ? waitForRetrySignal(LOCAL_PROXY_RECHECK_MS)
            : waitForSignal;
        handleSignal(yield* blockedWait);
        continue;
      }

      if (failedProbe) {
        resetRetryLadder();
        yield* setState(connectingState(yield* Ref.get(intent), generation, 1, latestFailure));
        continue;
      }

      const inWakeWindow = (yield* Clock.monotonicTimeNanos) < (yield* Ref.get(wakeRetryUntil));
      const delayMs = inWakeWindow
        ? WAKE_RETRY_DELAY_MS
        : retryDelayMs(failureCount, yield* Random.next, loopback);
      if (!inWakeWindow) failureCount += 1;
      pendingRetry = Option.map(attemptSpan, (previousAttempt) => ({
        previousAttempt,
        failureCount,
        delayMs,
        reason: error.reason,
      }));
      const failedIntent = yield* Ref.get(intent);
      yield* setState({
        desired: failedIntent.desired,
        network: failedIntent.network,
        phase: "backoff",
        stage: null,
        attempt: Math.max(1, failureCount),
        generation,
        lastFailure: latestFailure,
        retryAt: (yield* Clock.currentTimeMillis) + delayMs,
      });
      handleSignal(yield* waitForRetrySignal(delayMs));
    }
  });

  yield* connectivity.changes.pipe(
    Stream.runForEach((network) =>
      Ref.modify(intent, (current) =>
        current.network === network ? [false, current] : ([true, { ...current, network }] as const),
      ).pipe(
        Effect.flatMap((changed) =>
          changed ? signal({ _tag: "NetworkChanged", network }) : Effect.void,
        ),
      ),
    ),
    Effect.forkScoped,
  );
  yield* wakeups.changes.pipe(
    Stream.runForEach((reason) => signal({ _tag: "Wakeup", reason })),
    Effect.forkScoped,
  );
  yield* run().pipe(Effect.forkScoped);

  const connect = Ref.update(intent, (current) => ({
    ...current,
    desired: true,
  })).pipe(
    Effect.andThen(signal({ _tag: "ConnectRequested" })),
    Effect.withSpan("EnvironmentSupervisor.connect"),
  );

  const disconnect = Ref.update(intent, (current) => ({
    ...current,
    desired: false,
  })).pipe(
    Effect.andThen(signal({ _tag: "DisconnectRequested" })),
    Effect.withSpan("EnvironmentSupervisor.disconnect"),
  );

  const retryNow = Ref.set(resetRetryState, true).pipe(
    Effect.andThen(signal({ _tag: "RetryRequested" })),
    Effect.withSpan("EnvironmentSupervisor.retryNow"),
  );

  yield* Effect.addFinalizer(() => Queue.shutdown(signals).pipe(Effect.andThen(clearLease)));

  return EnvironmentSupervisor.of({
    target,
    state,
    session,
    prepared,
    connect,
    disconnect,
    retryNow,
  });
});
