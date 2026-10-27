import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { ConnectionRoute } from "./catalog.ts";
import type * as ConnectionDriver from "./driver.ts";
import { ConnectionTransientError, type ConnectionTarget } from "./model.ts";
import { loopbackBudget } from "./loopbackHost.ts";
import { connectionRouteId, connectionRouteKind, type ConnectionRouteKind } from "./routes.ts";
import type { SupervisorSignal } from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";

type QueuedSignal = SupervisorSignal & { readonly attemptSequence: number };

const CONNECTION_PROBE_TIMEOUT = "15 seconds";
const QUICK_CONNECTION_PROBE_TIMEOUT = "3 seconds";
// A probe still unanswered this long checks the host with a fresh request. If
// the host answers while the socket stays silent, the socket is dead.
const SILENT_SOCKET_CHECK_AFTER = "500 millis";
const SILENT_SOCKET_RECHECK_EVERY = "1 second";
// Off the LAN one lost packet can stall a live socket for a second, so a remote
// socket must stay silent this long. It must end before
// QUICK_CONNECTION_PROBE_TIMEOUT so a long resume replaces a silent socket
// instead of timing out.
const REMOTE_SILENT_SOCKET_AFTER = "2500 millis";

const BETTER_ROUTE_CHECK_INTERVAL = "60 seconds";

export function makeConnectedLeaseMonitor(input: {
  readonly target: ConnectionTarget;
  readonly loopback: boolean;
  readonly currentRoutes: Effect.Effect<ReadonlyArray<ConnectionRoute>>;
  readonly signals: Queue.Queue<QueuedSignal>;
  readonly resetRetryState: Ref.Ref<boolean>;
  readonly probeUnanswered: Ref.Ref<boolean>;
  readonly driver: ConnectionDriver.ConnectionDriver["Service"];
  readonly connectedLeaseEnd: (
    signal: SupervisorSignal,
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) => Effect.Effect<"end" | "reset" | undefined>;
  readonly requestBetterRouteCheck: (
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) => Effect.Effect<void>;
}) {
  const {
    target,
    loopback,
    currentRoutes,
    signals,
    resetRetryState,
    probeUnanswered,
    driver,
    connectedLeaseEnd,
    requestBetterRouteCheck,
  } = input;
  const leaseRouteKind = (lease: ConnectionDriver.EnvironmentConnectionLease) =>
    currentRoutes.pipe(
      Effect.map((routes) => {
        const route = routes.find(
          (candidate) =>
            connectionRouteId(candidate.target) === connectionRouteId(lease.prepared.target),
        );
        return route === undefined ? undefined : connectionRouteKind(route);
      }),
    );

  const isLongResume = (signal: SupervisorSignal) =>
    signal._tag === "Wakeup" && signal.reason === "application-active-long";

  const answersQuickly = (routeKind: ConnectionRouteKind | undefined) =>
    routeKind === "loopback" || routeKind === "lan";

  const probeTimeoutFor = (
    next: SupervisorSignal,
    routeKind: ConnectionRouteKind | undefined,
  ): Duration.Input | undefined => {
    switch (next._tag) {
      case "RetryRequested":
        return QUICK_CONNECTION_PROBE_TIMEOUT;
      case "NetworkChanged":
        return next.network === "offline" ? QUICK_CONNECTION_PROBE_TIMEOUT : undefined;
      case "Wakeup":
        if (next.reason === "application-active") {
          return CONNECTION_PROBE_TIMEOUT;
        }
        // After a long suspension the data on screen is stale, so a slow
        // answer reconnects as quickly as a missing one, even on a remote
        // route where a reconnect takes longer than the wait it replaces.
        if (next.reason === "application-active-long") {
          return QUICK_CONNECTION_PROBE_TIMEOUT;
        }
        if (next.reason !== "application-active-probe" && next.reason !== "network-changed") {
          return undefined;
        }
        // Only loopback and LAN answer within 3 seconds reliably. A tailnet
        // over DERP, a VPN, or the relay can spike past it on a live socket;
        // a dead one is still caught early by the silent socket check.
        return answersQuickly(routeKind)
          ? QUICK_CONNECTION_PROBE_TIMEOUT
          : CONNECTION_PROBE_TIMEOUT;
      case "ConnectRequested":
      case "DisconnectRequested":
      case "BetterRouteAvailable":
        return undefined;
    }
  };

  // Ends "silent" when the host answers a fresh request while the socket
  // delivers nothing, as when iOS kills a suspended socket without a close
  // event, and "alive" once the socket delivers a frame. A slow or
  // unreachable host never ends it.
  const awaitSilentSocket = Effect.fn("EnvironmentSupervisor.awaitSilentSocket")(function* (
    lease: ConnectionDriver.EnvironmentConnectionLease,
    routeKind: ConnectionRouteKind | undefined,
  ) {
    const startedAt = yield* Clock.monotonicTimeNanos;
    yield* Effect.sleep(SILENT_SOCKET_CHECK_AFTER);
    // An older host answers probes with its full config, which can be slow
    // enough to lose to a fresh request on a healthy socket.
    const answersCheapProbe = yield* lease.session.initialConfig.pipe(
      Effect.map((config) => config.environment.capabilities.connectionProbe === true),
      Effect.catchCause(() => Effect.succeed(false)),
    );
    if (!answersCheapProbe) return yield* Effect.never;
    // Frames that queued while the app was suspended have drained by now, so
    // a later frame shows the path still works.
    const framesBefore = yield* lease.session.inboundFrames;
    const socketSilent = lease.session.inboundFrames.pipe(
      Effect.map((frames) => frames === framesBefore),
    );
    // A radio still waking up or a stale pooled connection can fail one check.
    while ((yield* driver.checkHost(lease.prepared)) !== "answered") {
      if (!(yield* socketSilent)) return "alive" as const;
      yield* Effect.sleep(SILENT_SOCKET_RECHECK_EVERY);
    }
    if (!answersQuickly(routeKind)) {
      const silentFor = (yield* Clock.monotonicTimeNanos) - startedAt;
      const remaining = Duration.toNanosUnsafe(REMOTE_SILENT_SOCKET_AFTER) - silentFor;
      if (remaining > 0n) yield* Effect.sleep(Duration.nanos(remaining));
    }
    return (yield* socketSilent) ? ("silent" as const) : ("alive" as const);
  });

  // Returning to the app, an explicit retry, and the network reporting offline
  // all probe the live session instead of replacing it, so a healthy socket is
  // not torn down (the offline report is often wrong, for example for a
  // loopback server).
  return Effect.fnUntraced(function* (lease: ConnectionDriver.EnvironmentConnectionLease) {
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
    const routeKind = yield* leaseRouteKind(lease);
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
      const probeTimeout = probeTimeoutFor(next, routeKind);
      if (probeTimeout === undefined) {
        continue;
      }
      yield* Ref.set(probeUnanswered, true);
      const probe = yield* Effect.forkChild(lease.session.probe);
      let silentSocket: Fiber.Fiber<"silent" | "alive"> | undefined;
      // A signal during a running check, such as a network change that kills
      // the socket, needs a fresh check only if the running one sees a frame.
      let recheck = false;
      let longResume = isLongResume(next);
      const startSilentSocketCheck = Effect.gen(function* () {
        silentSocket = yield* Effect.forkChild(awaitSilentSocket(lease, routeKind));
        recheck = false;
      });
      // The web and desktop foreground probe allows a busy host 15 seconds,
      // and a busy host can answer a fresh request before a queued probe.
      const armSilentSocketCheck = Effect.fnUntraced(function* (signal: SupervisorSignal) {
        if (signal._tag === "Wakeup" && signal.reason === "application-active") return;
        if (silentSocket !== undefined) {
          recheck = true;
          return;
        }
        yield* startSilentSocketCheck;
      });
      yield* armSilentSocketCheck(next);
      const stopProbe = Effect.suspend(() =>
        Effect.all(
          [Fiber.interrupt(probe), silentSocket ? Fiber.interrupt(silentSocket) : Effect.void],
          { discard: true },
        ),
      );
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
          (silentSocket ? Fiber.join(silentSocket) : Effect.never).pipe(
            Effect.map((check) =>
              check === "silent"
                ? { _tag: "SocketSilent" as const }
                : { _tag: "SocketAlive" as const },
            ),
          ),
        ]);
        if (probeEvent._tag === "SocketAlive") {
          silentSocket = undefined;
          if (recheck) yield* startSilentSocketCheck;
          continue;
        }
        if (probeEvent._tag === "SocketSilent") {
          // The host is reachable, so replace the socket at once, even while
          // the network reports offline.
          yield* stopProbe;
          return true;
        }
        if (probeEvent._tag === "TimedOut") {
          yield* stopProbe;
          // A long suspension leaves the socket suspect even when the network
          // reports offline, so it is replaced like a silent one.
          if (longResume) return true;
          return yield* new ConnectionTransientError({
            reason: "timeout",
            detail: `${target.label} did not respond to a connection health check.`,
          });
        }
        if (probeEvent._tag === "ProbeCompleted") {
          if (silentSocket) yield* Fiber.interrupt(silentSocket);
          if (Exit.isSuccess(probeEvent.exit)) {
            yield* Ref.set(probeUnanswered, false);
          }
          yield* probeEvent.exit;
          break;
        }
        const endDuringProbe = yield* connectedLeaseEnd(probeEvent.signal, lease);
        if (endDuringProbe !== undefined) {
          yield* stopProbe;
          return endDuringProbe === "reset";
        }
        const signalTimeout = probeTimeoutFor(probeEvent.signal, routeKind);
        if (signalTimeout !== undefined) {
          yield* armSilentSocketCheck(probeEvent.signal);
          longResume ||= isLongResume(probeEvent.signal);
          const signalDeadline =
            (yield* Clock.monotonicTimeNanos) +
            Duration.toNanosUnsafe(loopbackBudget(loopback, signalTimeout));
          if (signalDeadline < deadline) deadline = signalDeadline;
        }
      }
    }
  });
}
