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
import type { ConnectionTarget, NetworkStatus } from "./model.ts";
import { loopbackBudget } from "./loopbackHost.ts";
import { connectionRouteId, connectionRouteKind, type ConnectionRouteKind } from "./routes.ts";
import type { SupervisorSignal } from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";

type QueuedSignal = SupervisorSignal & { readonly attemptSequence: number };
const BETTER_ROUTE_CHECK_INTERVAL = "60 seconds";

export function makeConnectedLeaseMonitor(input: {
  readonly target: ConnectionTarget;
  readonly loopback: boolean;
  readonly currentRoutes: Effect.Effect<ReadonlyArray<ConnectionRoute>>;
  readonly currentNetwork: Effect.Effect<NetworkStatus>;
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
    loopback,
    currentRoutes,
    currentNetwork,
    signals,
    resetRetryState,
    probeUnanswered,
    connectedLeaseEnd,
    requestBetterRouteCheck,
  } = input;
  const mayReplace = (signal: SupervisorSignal) =>
    (signal._tag === "NetworkChanged" && signal.network === "online") ||
    (signal._tag === "Wakeup" &&
      (signal.reason === "network-changed" || signal.reason === "application-active-long"));
  const probeTimeoutFor = (
    signal: SupervisorSignal,
    route: ConnectionRouteKind | undefined,
  ): Duration.Input | undefined => {
    if (
      signal._tag === "RetryRequested" ||
      (signal._tag === "NetworkChanged" && signal.network === "offline")
    )
      return "3 seconds";
    if (signal._tag !== "Wakeup") return undefined;
    if (signal.reason === "application-active") return "15 seconds";
    if (signal.reason === "application-active-long") return "3 seconds";
    if (signal.reason !== "application-active-probe" && signal.reason !== "network-changed")
      return undefined;
    return route === "loopback" || route === "lan" ? "3 seconds" : "15 seconds";
  };
  const checkReplacement = Effect.fn("EnvironmentSupervisor.checkReplacement")(function* (
    lease: ConnectionDriver.EnvironmentConnectionLease,
    event: { readonly at: bigint; readonly frames: number },
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const opened = yield* Effect.exit(lease.openProbeSocket.pipe(Effect.timeout("15 seconds")));
        if (Exit.isFailure(opened)) return false;
        const sentAt = yield* Clock.monotonicTimeNanos;
        const answered = yield* Effect.exit(opened.value.probe.pipe(Effect.timeout("15 seconds")));
        if (Exit.isFailure(answered)) return false;
        const rtt = (yield* Clock.monotonicTimeNanos) - sentAt;
        const quiet = rtt * 2n > 5_000_000_000n ? rtt * 2n : 5_000_000_000n;
        const remaining = event.at + quiet - (yield* Clock.monotonicTimeNanos);
        if (remaining > 0n) yield* Effect.sleep(Duration.nanos(remaining));
        yield* opened.value.drainIo;
        return (
          (yield* currentNetwork) !== "offline" &&
          (yield* lease.session.inboundFrames) === event.frames
        );
      }),
    );
  });
  return Effect.fnUntraced(function* (lease: ConnectionDriver.EnvironmentConnectionLease) {
    const takeSignal = Queue.take(signals).pipe(
      Effect.tap((next) =>
        next._tag === "RetryRequested" ? Ref.set(resetRetryState, false) : Effect.void,
      ),
    );
    yield* Stream.tick(BETTER_ROUTE_CHECK_INTERVAL).pipe(
      Stream.drop(1),
      Stream.runForEach(() => requestBetterRouteCheck(lease)),
      Effect.forkScoped,
    );
    const routes = yield* currentRoutes;
    const route = routes.find(
      (candidate) =>
        connectionRouteId(candidate.target) === connectionRouteId(lease.prepared.target),
    );
    const routeKind = route === undefined ? undefined : connectionRouteKind(route);
    let probe: Fiber.Fiber<Exit.Exit<void, unknown>> | undefined;
    let replacement: Fiber.Fiber<boolean> | undefined;
    for (;;) {
      const event = yield* Effect.raceAllFirst([
        takeSignal.pipe(Effect.map((signal) => ({ _tag: "Signal" as const, signal }))),
        (probe ? Fiber.join(probe) : Effect.never).pipe(
          Effect.map((exit) => ({ _tag: "Probe" as const, exit })),
        ),
        (replacement ? Fiber.join(replacement) : Effect.never).pipe(
          Effect.map((replace) => ({ _tag: "Replacement" as const, replace })),
        ),
      ]);
      if (event._tag === "Probe") {
        probe = undefined;
        if (Exit.isSuccess(event.exit)) yield* Ref.set(probeUnanswered, false);
        continue;
      }
      if (event._tag === "Replacement") {
        replacement = undefined;
        if (event.replace && (yield* currentNetwork) !== "offline") return true;
        continue;
      }
      const next = event.signal;
      const end = yield* connectedLeaseEnd(next, lease);
      if (end !== undefined) return end === "reset";
      if (
        (next._tag === "NetworkChanged" && next.network !== "offline") ||
        (next._tag === "Wakeup" && ConnectionWakeups.resetsRetryBackoff(next.reason))
      )
        yield* requestBetterRouteCheck(lease);
      if (next._tag === "NetworkChanged" && next.network === "offline" && replacement) {
        yield* Fiber.interrupt(replacement);
        replacement = undefined;
      }
      if (mayReplace(next) && (yield* currentNetwork) !== "offline") {
        if (replacement) yield* Fiber.interrupt(replacement);
        const at = yield* Clock.monotonicTimeNanos;
        const frames = yield* lease.session.inboundFrames;
        replacement = yield* Effect.forkChild(checkReplacement(lease, { at, frames }));
      }
      const timeout = probeTimeoutFor(next, routeKind);
      if (timeout !== undefined) {
        if (probe) yield* Fiber.interrupt(probe);
        yield* Ref.set(probeUnanswered, true);
        probe = yield* Effect.forkChild(
          lease.session.probe.pipe(Effect.timeout(loopbackBudget(loopback, timeout)), Effect.exit),
        );
      }
    }
  });
}
