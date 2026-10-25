import { vi } from "vite-plus/test";

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

import {
  AuthStandardClientScopes,
  EnvironmentId,
  type ServerConfig,
  type DesktopSshPreparationProgress,
} from "@goat/contracts";

import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { fetchEnvironmentSessionState } from "../state/session.ts";
import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import { BearerConnectionProfile } from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionAttemptSuperseded,
  SshConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type ConnectionAttemptError,
  type ConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as RpcSession from "../rpc/session.ts";
import { presentConnectionState } from "./presentation.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { sshPreparationFailure } from "./sshFailure.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import { connectionRouteId, entryWithRoutes, isLearned, mergeLearnedRoutes } from "./routes.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const RELAY_TARGET = new RelayConnectionTarget({
  environmentId: TARGET.environmentId,
  label: TARGET.label,
});

const TARGET_ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.none(),
  enabled: true,
};

const RELAY_ENTRY: ConnectionCatalogEntry = {
  target: RELAY_TARGET,
  profile: Option.none(),
  enabled: true,
};

const PREPARED_CONNECTION: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

const TEST_RPC_CLIENT = {} as WsRpcProtocolClient;

const LAN_TARGET = new BearerConnectionTarget({
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  connectionId: "bearer:lan",
});
const LAN_ROUTE: ConnectionRoute = {
  target: LAN_TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: LAN_TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "http://192.168.1.10:3773/",
      wsBaseUrl: "ws://192.168.1.10:3773/",
    }),
  ),
};
const LAN_THEN_RELAY_ENTRY: ConnectionCatalogEntry = {
  target: LAN_ROUTE.target,
  profile: LAN_ROUTE.profile,
  alternateRoutes: [{ target: RELAY_TARGET, profile: Option.none() }],
  enabled: true,
};

function preparedFor(target: ConnectionTarget): PreparedConnection {
  return { ...PREPARED_CONNECTION, target };
}

function transient(message = "Connection failed.") {
  return new ConnectionTransientError({
    reason: "transport",
    detail: message,
  });
}

function blocked(message = "Authentication required.") {
  return new ConnectionBlockedError({
    reason: "authentication",
    detail: message,
  });
}

function awaitState(
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  predicate: (value: SupervisorConnectionState) => boolean,
) {
  return SubscriptionRef.changes(state).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

const eventuallyState = Effect.fn("TestConnectionHarness.eventuallyState")(function* (
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  predicate: (value: SupervisorConnectionState) => boolean,
) {
  return yield* awaitState(state, predicate);
});

const makeHarness = Effect.fn("TestConnectionHarness.make")(function* (options?: {
  readonly networkStatus?: NetworkStatus;
  readonly random?: number;
  readonly prepare?: (
    attempt: number,
    target: ConnectionTarget,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
  ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  readonly reportSynchronizing?: boolean;
  readonly ready?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
  readonly probe?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
  readonly initialConfig?: (attempt: number) => Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly checkRoute?: (route: ConnectionRoute) => Effect.Effect<ConnectionDriver.RouteCheck>;
}) {
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>(
    options?.networkStatus ?? "online",
  );
  const prepareCount = yield* Ref.make(0);
  const sessionCount = yield* Ref.make(0);
  const releaseCount = yield* Ref.make(0);
  const wakeups = yield* SubscriptionRef.make<{
    readonly sequence: number;
    readonly reason: ConnectionWakeups.ConnectionWakeup;
  }>({
    sequence: 0,
    reason: "application-active",
  });
  const closedSessions = yield* Ref.make<
    ReadonlyArray<Deferred.Deferred<never, ConnectionTransientError>>
  >([]);

  const connectivity = Connectivity.Connectivity.of({
    status: SubscriptionRef.get(networkStatus),
    changes: SubscriptionRef.changes(networkStatus),
  });

  const prepare = Effect.fn("TestConnectionDriver.prepare")(function* (
    target: ConnectionTarget,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    const attempt = yield* Ref.updateAndGet(prepareCount, (count) => count + 1);
    if (options?.prepare) {
      return yield* options.prepare(attempt, target, reportProgress);
    }
    return PREPARED_CONNECTION;
  });

  const checkRoute = (route: ConnectionRoute) =>
    options?.checkRoute?.(route) ?? Effect.succeed<ConnectionDriver.RouteCheck>("unchecked");

  const connectRoute = Effect.fn("TestConnectionDriver.connectRoute")(function* (
    target: ConnectionTarget,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    yield* reportProgress({ stage: "preparing", routeId: connectionRouteId(target) });
    const prepared = yield* prepare(target, reportProgress);
    yield* reportProgress({ stage: "opening", prepared });

    const attempt = yield* Ref.updateAndGet(sessionCount, (count) => count + 1);
    const closed = yield* Deferred.make<never, ConnectionTransientError>();
    yield* Ref.update(closedSessions, (sessions) => [...sessions, closed]);

    const session = yield* Effect.acquireRelease(
      Effect.succeed({
        client: TEST_RPC_CLIENT,
        initialConfig:
          options?.initialConfig?.(attempt) ??
          Effect.die(new Error("Initial config is not used by supervisor tests.")),
        subscribeServerConfig: (input) => TEST_RPC_CLIENT.subscribeServerConfig(input),
        ready: options?.ready?.(attempt) ?? Effect.void,
        probe: options?.probe?.(attempt) ?? Effect.void,
        closed: Deferred.await(closed),
      } satisfies RpcSession.RpcSession),
      () => Ref.update(releaseCount, (count) => count + 1),
    );

    if (options?.reportSynchronizing !== false) {
      yield* reportProgress({ stage: "synchronizing", prepared });
    }
    yield* session.ready;
    return { prepared, session } satisfies ConnectionDriver.EnvironmentConnectionLease;
  });

  const connect = Effect.fn("TestConnectionDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    yield* reportProgress({ stage: "preparing" });
    return yield* ConnectionDriver.connectOverRoutes(entry, checkRoute, (route) =>
      connectRoute(route.target, reportProgress),
    );
  });

  const layerDependencies = Layer.mergeAll(
    Layer.succeed(Random.Random, {
      nextDoubleUnsafe: () => options?.random ?? 1 - Number.EPSILON,
      nextIntUnsafe: () => 0,
    }),
    Layer.succeed(Connectivity.Connectivity, connectivity),
    Layer.succeed(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({
        changes: SubscriptionRef.changes(wakeups).pipe(
          Stream.drop(1),
          Stream.map((event) => event.reason),
        ),
      }),
    ),
    Layer.succeed(
      ConnectionDriver.ConnectionDriver,
      ConnectionDriver.ConnectionDriver.of({
        connect,
        checkRoute: (_entry, route) => checkRoute(route),
        preflight: (_entry, route) =>
          checkRoute(route).pipe(Effect.map((check) => check === "answered")),
      }),
    ),
  );

  return {
    dependencies: layerDependencies,
    prepareCount,
    sessionCount,
    releaseCount,
    setNetworkStatus: (status: NetworkStatus) => SubscriptionRef.set(networkStatus, status),
    wake: (reason: ConnectionWakeups.ConnectionWakeup) =>
      SubscriptionRef.update(wakeups, (event) => ({
        sequence: event.sequence + 1,
        reason,
      })),
    closeLatestSession: Effect.fn("TestConnectionHarness.closeLatestSession")(function* (
      error = transient("Session closed."),
    ) {
      const sessions = yield* Ref.get(closedSessions);
      const latest = sessions.at(-1);
      if (latest) {
        yield* Deferred.fail(latest, error);
      }
    }),
  };
});

describe("retryDelayMs", () => {
  it("clamps huge failure counts, negative inputs, and random=1 edge values within bounds", () => {
    for (const hugeFailureCount of [
      100,
      1_024,
      10_000,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_VALUE,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(EnvironmentSupervisor.retryDelayMs(hugeFailureCount, 0)).toBe(150_000);
      expect(EnvironmentSupervisor.retryDelayMs(hugeFailureCount, 0.5)).toBe(225_000);
      expect(EnvironmentSupervisor.retryDelayMs(hugeFailureCount, 1)).toBe(300_000);
    }

    expect(EnvironmentSupervisor.retryDelayMs(-1, 0)).toBe(1_000);
    expect(EnvironmentSupervisor.retryDelayMs(-1, 1)).toBe(2_000);
    expect(EnvironmentSupervisor.retryDelayMs(Number.NaN, 0.5)).toBe(1_500);
    expect(EnvironmentSupervisor.retryDelayMs(0, -1)).toBe(1_000);
    expect(EnvironmentSupervisor.retryDelayMs(0, 2)).toBe(2_000);
    expect(EnvironmentSupervisor.retryDelayMs(0, Number.NaN)).toBe(1_000);
    expect(EnvironmentSupervisor.retryDelayMs(0, Number.POSITIVE_INFINITY)).toBe(2_000);
    expect(EnvironmentSupervisor.retryDelayMs(0, Number.NEGATIVE_INFINITY)).toBe(1_000);
  });
});

describe("EnvironmentSupervisor", () => {
  it.effect("does not attempt a connection until it is desired", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY).pipe(
        Effect.provide(harness.dependencies),
      );

      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("available");
      expect(yield* Ref.get(harness.prepareCount)).toBe(0);
    }),
  );

  it.effect("does not let the initial connect signal cancel the first attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY).pipe(
        Effect.provide(harness.dependencies),
      );

      yield* supervisor.connect;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
    }),
  );

  it.effect("waits while offline and connects immediately when the network returns", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ networkStatus: "offline" });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "offline");
      expect(yield* Ref.get(harness.prepareCount)).toBe(0);

      yield* harness.setNetworkStatus("online");
      const ready = yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(ready).toMatchObject({
        desired: true,
        network: "online",
        phase: "connected",
        attempt: 1,
        generation: 1,
        lastFailure: null,
      });
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );

  it.effect("uses flat wake retries for 30 seconds without advancing the failure ladder", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        random: 0.25,
        prepare: () => Effect.fail(transient()),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* TestClock.adjust(1_250);
      expect((yield* SubscriptionRef.get(supervisor.state)).attempt).toBe(2);

      yield* harness.wake("application-active-reconnect");
      yield* TestClock.adjust(0);
      const wokeAt = yield* Clock.currentTimeMillis;
      for (let index = 0; index < 15; index += 1) {
        const retrying = yield* SubscriptionRef.get(supervisor.state);
        expect(retrying).toMatchObject({ phase: "backoff", attempt: 1 });
        expect(retrying.retryAt).toBe(wokeAt + (index + 1) * 2_000);
        expect(yield* Ref.get(harness.prepareCount)).toBe(index + 3);
        yield* TestClock.adjust(1_999);
        expect(yield* Ref.get(harness.prepareCount)).toBe(index + 3);
        yield* TestClock.adjust(1);
      }

      const firstAfterWindow = yield* SubscriptionRef.get(supervisor.state);
      expect(firstAfterWindow).toMatchObject({ phase: "backoff", attempt: 1 });
      expect(firstAfterWindow.retryAt! - (yield* Clock.currentTimeMillis)).toBe(1_250);
      yield* TestClock.adjust(1_250);
      const secondAfterWindow = yield* SubscriptionRef.get(supervisor.state);
      expect(secondAfterWindow).toMatchObject({ phase: "backoff", attempt: 2 });
      expect(secondAfterWindow.retryAt! - (yield* Clock.currentTimeMillis)).toBe(2_500);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["application-active-probe", "application-active", "network-changed"] as const)(
    "%s resets the ladder without opening a flat wake window",
    (reason) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          random: 0.25,
          prepare: () => Effect.fail(transient()),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));
        yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
        yield* harness.wake(reason);
        yield* TestClock.adjust(0);
        const reset = yield* SubscriptionRef.get(supervisor.state);
        expect(reset.retryAt! - (yield* Clock.currentTimeMillis)).toBe(1_250);
        yield* TestClock.adjust(1_250);
        const escalated = yield* SubscriptionRef.get(supervisor.state);
        expect(escalated).toMatchObject({ phase: "backoff", attempt: 2 });
        expect(escalated.retryAt! - (yield* Clock.currentTimeMillis)).toBe(2_500);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("suspend cancels establishment without a failure and wake runs one replacement", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        ready: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.stage === "synchronizing");
      yield* harness.wake("suspend");
      yield* TestClock.adjust(0);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      yield* TestClock.adjust("1 minute");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      expect((yield* SubscriptionRef.get(supervisor.state)).lastFailure).toBeNull();

      yield* harness.wake("application-active-reconnect");
      yield* harness.wake("application-active-probe");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* TestClock.adjust(0);
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        attempt: 1,
        generation: 1,
        lastFailure: null,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("suspend cancels a pending retry until a short resume", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* harness.wake("suspend");
      yield* TestClock.adjust("1 minute");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      yield* harness.wake("application-active-probe");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      expect((yield* SubscriptionRef.get(supervisor.state)).attempt).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps the latest failure visible throughout the next connection attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient("Relay connection timed out.")) : Effect.never,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");

      const retrying = yield* awaitState(
        supervisor.state,
        (state) =>
          state.phase === "connecting" && state.stage === "preparing" && state.attempt === 2,
      );
      expect(retrying).toMatchObject({
        phase: "connecting",
        stage: "preparing",
        attempt: 2,
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "transport",
          message: "Relay connection timed out.",
        },
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("converts unexpected driver defects into retryable failures", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1
            ? Effect.die(new Error("Native transport defect."))
            : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      const failed = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(failed).toMatchObject({
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "transport",
          message: "Test environment connection failed unexpectedly.",
        },
      });

      yield* TestClock.adjust("3 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("explicit retry interrupts the current backoff", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* supervisor.retryNow;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }),
  );

  it.effect("keeps blocked failures idle until an external signal requests another attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(blocked()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      yield* TestClock.adjust("1 hour");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);

      yield* supervisor.retryNow;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("rechecks a local proxy every minute while keeping the blocked state until ready", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const proxyFailure = sshPreparationFailure("Tailscale is stopped.");
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt <= 2 ? Effect.fail(proxyFailure) : Effect.succeed(PREPARED_CONNECTION),
        ready: () => Deferred.await(ready),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      const initial = yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      const phases: Array<string> = [];
      yield* SubscriptionRef.changes(supervisor.state).pipe(
        Stream.runForEach((state) =>
          Effect.sync(() => {
            phases.push(state.phase);
          }),
        ),
        Effect.forkScoped,
      );
      yield* TestClock.adjust(59_999);
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      yield* TestClock.adjust(1);
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        ...initial,
        failureOrigin: { ...initial.failureOrigin, attemptId: 2 },
      });
      yield* TestClock.adjust(59_999);
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      yield* TestClock.adjust(1);
      expect(yield* Ref.get(harness.prepareCount)).toBe(3);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        ...initial,
        failureOrigin: { ...initial.failureOrigin, attemptId: 2 },
      });
      expect(phases.every((phase) => phase === "blocked")).toBe(true);
      yield* Deferred.succeed(ready, undefined);
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(phases).not.toContain("connecting");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each([
    "Host key verification failed.",
    "mbp runs a newer GOAT (0.3.0).",
    "Permission denied (publickey).",
  ])("does not schedule a blocked recheck for %s", (message) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: () => Effect.fail(sshPreparationFailure(message)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      yield* TestClock.adjust("1 hour");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("retries a blocked connection when platform credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(blocked()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      yield* harness.wake("credentials-changed");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }),
  );

  it.effect("does not let platform wakeups reset an in-flight attempt", () =>
    Effect.gen(function* () {
      const firstAttemptStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: () =>
          Deferred.succeed(firstAttemptStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(firstAttemptStarted);
      yield* Effect.all(
        [
          harness.wake("credentials-changed"),
          harness.wake("application-active"),
          harness.wake("credentials-changed"),
        ],
        { concurrency: "unbounded" },
      );
      yield* Effect.yieldNow;

      expect(yield* Ref.get(harness.prepareCount)).toBe(1);

      yield* TestClock.adjust("15 seconds");
      const retrying = yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );

      expect(retrying).toMatchObject({
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "timeout",
          message: "Test environment did not respond during connection setup.",
        },
      });
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("treats an involuntary session close as transient and reconnects", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);

      yield* TestClock.adjust("3 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(Option.isSome(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not report a session lost while suspended as a failed connection", () =>
    Effect.gen(function* () {
      const allowReconnect = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 2
            ? Deferred.await(allowReconnect).pipe(Effect.as(PREPARED_CONNECTION))
            : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      // The OS killed the socket while the app was suspended; its close arrives
      // before the app reports it is active again.
      yield* harness.closeLatestSession();
      const waiting = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      expect(presentConnectionState(waiting)).toMatchObject({
        phase: "reconnecting",
        error: null,
        traceId: null,
      });

      yield* harness.wake("application-active");
      const replacing = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.stage === "preparing",
      );
      expect(presentConnectionState(replacing).error).toBeNull();

      yield* Deferred.succeed(allowReconnect, undefined);
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("restarts the retry ladder when a long resume replaces a connected session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("2 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 2,
      );

      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 3 && state.attempt === 1,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["application-active-reconnect", "application-active-probe"] as const)(
    "a desktop %s wakeup during a deep backoff retries at once from the first rung",
    (reason) =>
      Effect.gen(function* () {
        // The host is unreachable while the lid is closed, then answers again.
        const harness = yield* makeHarness({
          prepare: (attempt) =>
            attempt <= 5 ? Effect.fail(transient()) : Effect.succeed(PREPARED_CONNECTION),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        for (const [index, delay] of [2_000, 4_000, 8_000].entries()) {
          yield* eventuallyState(
            supervisor.state,
            (state) => state.phase === "backoff" && state.attempt === index + 1,
          );
          yield* TestClock.adjust(delay);
        }
        const deep = yield* eventuallyState(
          supervisor.state,
          (state) => state.phase === "backoff" && state.attempt === 4,
        );
        expect(deep.retryAt! - (yield* Clock.currentTimeMillis)).toBe(16_000);

        // No clock advance: the wakeup itself starts the next attempt.
        yield* harness.wake(reason);
        const reset = yield* eventuallyState(
          supervisor.state,
          (state) => state.phase === "backoff" && state.attempt === 1,
        );
        expect(yield* Ref.get(harness.prepareCount)).toBe(5);
        expect(reset.retryAt! - (yield* Clock.currentTimeMillis)).toBe(2_000);

        yield* TestClock.adjust(2_000);
        yield* eventuallyState(
          supervisor.state,
          (state) =>
            state.phase === "connected" &&
            state.attempt === (reason === "application-active-reconnect" ? 1 : 2),
        );
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("probes the active session without reconnecting on application activation", () =>
    Effect.gen(function* () {
      const probeCount = yield* Ref.make(0);
      const probeCalled = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: () =>
          Ref.update(probeCount, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(probeCalled, undefined)),
          ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* Deferred.await(probeCalled);

      expect(yield* Ref.get(probeCount)).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
    }),
  );

  it.effect("immediately replaces a mobile session after a long background resume", () =>
    Effect.gen(function* () {
      const probeCount = yield* Ref.make(0);
      const harness = yield* makeHarness({
        probe: () => Ref.update(probeCount, (count) => count + 1),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(probeCount)).toBe(0);
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("replaces a mobile session when a long resume interrupts an active probe", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* harness.wake("application-active-probe");
      yield* Effect.yieldNow;
      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("reconnects immediately when the session closes during a resume probe", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: (attempt) =>
          attempt === 1
            ? Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* Deferred.await(probeStarted);
      yield* harness.closeLatestSession();

      const reconnected = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(reconnected.attempt).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reconnects immediately when the foreground liveness probe fails", () =>
    Effect.gen(function* () {
      const allowReconnect = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 2
            ? Deferred.await(allowReconnect).pipe(Effect.as(PREPARED_CONNECTION))
            : Effect.succeed(PREPARED_CONNECTION),
        probe: (attempt) =>
          attempt === 1 ? Effect.fail(transient("The live session is stale.")) : Effect.void,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      const reconnecting = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting",
      );
      expect(reconnecting.attempt).toBe(1);
      expect(reconnecting.lastFailure).toBeNull();
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);

      yield* Deferred.succeed(allowReconnect, undefined);
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 1,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("honors an explicit disconnect while a foreground probe is stalled", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: () => Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* Deferred.await(probeStarted);
      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("does not churn a healthy session when credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("credentials-changed");
      yield* Effect.yieldNow;

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
    }),
  );

  it.effect("releases and reconnects a relay session when credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: () => Effect.succeed(preparedFor(RELAY_TARGET)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("credentials-changed");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("refreshes HTTP authorization without replacing the active relay session", () =>
    Effect.gen(function* () {
      const endpoint = {
        httpBaseUrl: TARGET.httpBaseUrl,
        wsBaseUrl: TARGET.wsBaseUrl,
        providerKind: "cloudflare_tunnel" as const,
      };
      const token = yield* Ref.make(
        Option.some(
          new TokenStore.RemoteDpopAccessToken({
            environmentId: TARGET.environmentId,
            accountId: "test-account",
            label: TARGET.label,
            endpoint,
            accessToken: "access-token-1",
            expiresAtEpochMs: 3_600_000,
            dpopThumbprint: "test-thumbprint",
          }),
        ),
      );
      const bootstrapFails = yield* Ref.make(false);
      const bootstrapCalls = yield* Ref.make(0);
      const httpPaths: Array<string> = [];
      const sessionAuthorizations: Array<string | null> = [];
      const fetchFn = ((input, init) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        httpPaths.push(pathname);
        switch (pathname) {
          case "/.well-known/goat/environment":
            return Promise.resolve(
              Response.json({
                environmentId: TARGET.environmentId,
                label: TARGET.label,
                platform: { os: "linux", arch: "x64" },
                serverVersion: "0.0.0-test",
                capabilities: { repositoryIdentity: true },
              }),
            );
          case "/oauth/token":
            return Promise.resolve(
              Response.json({
                access_token: "access-token-2",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "DPoP",
                expires_in: 3_600,
                scope: AuthStandardClientScopes.join(" "),
              }),
            );
          case "/api/auth/websocket-ticket":
            return Promise.resolve(
              Response.json({
                ticket: "ws-ticket",
                expiresAt: "2026-09-04T01:00:00.000Z",
              }),
            );
          case "/api/auth/session": {
            const authorization = request.headers.get("authorization");
            sessionAuthorizations.push(authorization);
            return Promise.resolve(
              Response.json({
                authenticated: authorization === "DPoP access-token-2",
                auth: {
                  policy: "loopback-browser",
                  bootstrapMethods: ["one-time-token"],
                  sessionMethods: ["dpop-access-token"],
                  sessionCookieName: "t3_session_test",
                },
                scopes: AuthStandardClientScopes,
              }),
            );
          }
          default:
            return Promise.reject(new Error(`Unexpected HTTP request to ${request.url}`));
        }
      }) satisfies typeof fetch;
      const signer = ManagedRelay.ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("test-thumbprint"),
        createProof: () => Effect.succeed("test-proof"),
      });
      const unused = () => Effect.die("Unexpected relay operation.");
      const relay = ManagedRelay.ManagedRelayClient.of({
        relayUrl: "https://relay.example.test",
        listEnvironments: unused,
        listDevices: unused,
        createEnvironmentLinkChallenge: unused,
        linkEnvironment: unused,
        unlinkEnvironment: unused,
        getEnvironmentStatus: unused,
        connectEnvironment: Effect.fn("TestConnectionHttp.connectEnvironment")(function* () {
          yield* Ref.update(bootstrapCalls, (count) => count + 1);
          if (yield* Ref.get(bootstrapFails)) {
            return yield* new ManagedRelay.ManagedRelayRequestTimeoutError({
              activity: "Relay environment connection",
              timeoutMs: 6_000,
              traceId: null,
            });
          }
          return {
            environmentId: TARGET.environmentId,
            endpoint,
            credential: "relay-bootstrap",
            expiresAt: "2026-09-04T01:00:00.000Z",
          };
        }),
        registerDevice: unused,
        unregisterDevice: unused,
        registerLiveActivity: unused,
        getAgentActivitySnapshot: unused,
        resetTokenCache: Effect.void,
      });
      const layerHttp = RpcHttp.layerRemoteHttpClient(fetchFn);
      const remoteAuthorization = yield* RemoteEnvironmentAuthorization.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            layerHttp,
            Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, signer),
            Layer.succeed(ManagedRelay.ManagedRelayClient, relay),
            Layer.succeed(ClientCapabilities.CloudSession, {
              identity: Effect.succeedSome({ accountId: "test-account" }),
              clerkToken: Effect.succeed("clerk-token"),
            }),
            Layer.succeed(ClientCapabilities.RelayDeviceIdentity, {
              deviceId: Effect.succeedNone,
            }),
            TokenStore.layer({
              get: () => Ref.get(token),
              put: (value) => Ref.set(token, Option.some(value)),
              remove: () => Ref.set(token, Option.none()),
            }),
            Layer.succeed(ClientCapabilities.ClientPresentation, {
              metadata: { label: "Test client", deviceType: "desktop" },
            }),
          ),
        ),
      );
      const harness = yield* makeHarness({
        prepare: () =>
          remoteAuthorization
            .authorizeDpop({ expectedEnvironmentId: TARGET.environmentId })
            .pipe(Effect.map((prepared) => ({ ...prepared, target: RELAY_TARGET }))),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const session = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      const readSession = fetchEnvironmentSessionState({
        prepared,
        signer: Option.some(signer),
        remoteAuthorization: Option.some(remoteAuthorization),
      }).pipe(Effect.provide(layerHttp));

      yield* TestClock.adjust("2 hours");
      expect((yield* readSession).authenticated).toBe(true);
      expect(sessionAuthorizations).toEqual(["DPoP access-token-2"]);
      expect(yield* Ref.get(bootstrapCalls)).toBe(1);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).toBe(session);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });

      yield* TestClock.adjust("2 hours");
      yield* Ref.set(bootstrapFails, true);
      const failure = yield* readSession.pipe(Effect.flip);
      expect(failure._tag).toBe("RemoteEnvironmentAuthFetchError");
      expect(yield* Ref.get(bootstrapCalls)).toBe(2);
      expect(sessionAuthorizations).toEqual(["DPoP access-token-2"]);
      expect(httpPaths.filter((path) => path === "/api/auth/websocket-ticket")).toHaveLength(1);
      expect(httpPaths.filter((path) => path === "/oauth/token")).toHaveLength(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).toBe(session);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not lose an explicit disconnect among concurrent wakeup signals", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* Effect.all(
        [
          supervisor.disconnect,
          harness.wake("credentials-changed"),
          harness.wake("application-active"),
          harness.wake("credentials-changed"),
        ],
        { concurrency: "unbounded" },
      );
      yield* awaitState(supervisor.state, (state) => state.phase === "available");

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);
    }),
  );
});

describe("adaptive connection setup deadline", () => {
  const learnSlowSetup = Effect.fn("TestConnectionHarness.learnSlowSetup")(function* (
    setupMs: number,
    nextPrepare: Effect.Effect<PreparedConnection, ConnectionAttemptError>,
    hostAnswer?: Effect.Effect<void>,
  ) {
    const setupStarted = yield* Deferred.make<void>();
    const finishSetup = yield* Deferred.make<void>();
    const harness = yield* makeHarness({
      prepare: (attempt, target, progress) =>
        attempt === 1
          ? Effect.succeed(preparedFor(target))
          : attempt === 2
            ? Deferred.succeed(setupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishSetup)),
                Effect.as(preparedFor(target)),
              )
            : (hostAnswer === undefined
                ? Effect.void
                : hostAnswer.pipe(
                    Effect.andThen(progress({ stage: "preparing", hostAnswered: true })),
                  )
              ).pipe(Effect.andThen(nextPrepare)),
      // A failed synchronized route leaves its existing snapshot allowance for the fallback.
      ready: (attempt) => (attempt === 1 ? Effect.fail(transient()) : Effect.void),
      initialConfig: () => Effect.succeed({ directEndpoints: [] } as unknown as ServerConfig),
    });
    const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
      initiallyDesired: true,
      learnRoutes: () => Effect.succeedSome(RELAY_ENTRY),
    }).pipe(Effect.provide(harness.dependencies));
    yield* Deferred.await(setupStarted);
    yield* TestClock.adjust(setupMs);
    yield* Deferred.succeed(finishSetup, undefined);
    yield* awaitState(supervisor.state, (state) => state.phase === "connected");
    yield* TestClock.adjust(0);
    yield* supervisor.disconnect;
    yield* awaitState(supervisor.state, (state) => state.phase === "available");
    return { harness, supervisor };
  });

  it.effect(
    "learns the full 20 second preparation across a free retry and allows a later 22 seconds",
    () =>
      Effect.gen(function* () {
        const initialSetup = yield* Deferred.make<void>();
        const laterSetup = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          prepare: (attempt, _target, progress) =>
            Effect.gen(function* () {
              yield* progress({ stage: "preparing", hostAnswered: true });
              if (attempt === 2) yield* Deferred.succeed(secondStarted, undefined);
              yield* Deferred.await(attempt <= 2 ? initialSetup : laterSetup);
              return PREPARED_CONNECTION;
            }),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));
        yield* awaitState(supervisor.state, (state) => state.stage === "preparing");
        yield* TestClock.adjust("15 seconds");
        yield* Deferred.await(secondStarted);
        expect((yield* SubscriptionRef.get(supervisor.state)).attempt).toBe(1);
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.succeed(initialSetup, undefined);
        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        yield* supervisor.disconnect;
        yield* awaitState(supervisor.state, (state) => state.phase === "available");
        yield* supervisor.connect;
        yield* awaitState(supervisor.state, (state) => state.stage === "preparing");
        yield* TestClock.adjust("22 seconds");
        expect(yield* Ref.get(harness.prepareCount)).toBe(3);
        expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connecting");
        yield* Deferred.succeed(laterSetup, undefined);
        expect(
          yield* awaitState(supervisor.state, (state) => state.phase === "connected"),
        ).toMatchObject({ attempt: 1, lastFailure: null });
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("retains a fallback route's preparation start across retries of earlier routes", () =>
    Effect.gen(function* () {
      const finishSetup = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (attempt, target, progress) =>
          target === LAN_TARGET
            ? Effect.fail(transient())
            : progress({ stage: "preparing", hostAnswered: true }).pipe(
                Effect.andThen(attempt <= 4 ? Deferred.await(finishSetup) : Effect.never),
                Effect.as(preparedFor(target)),
              ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.stage === "preparing");
      yield* TestClock.adjust("30 seconds");
      expect(yield* Ref.get(harness.prepareCount)).toBe(4);
      yield* TestClock.adjust("12 seconds");
      yield* Deferred.succeed(finishSetup, undefined);
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");
      yield* supervisor.connect;
      yield* awaitState(supervisor.state, (state) => state.stage === "preparing");
      yield* TestClock.adjust("89 seconds");
      expect(yield* Ref.get(harness.prepareCount)).toBe(6);
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connecting");
      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(harness.prepareCount)).toBe(8);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("excludes a failed route's 60 second synchronization from the setup sample", () =>
    Effect.gen(function* () {
      const failedSnapshot = yield* Deferred.make<void, ConnectionAttemptError>();
      const harness = yield* makeHarness({
        prepare: (attempt, target, progress) =>
          attempt <= 2
            ? Effect.succeed(preparedFor(target))
            : progress({ stage: "preparing", hostAnswered: true }).pipe(
                Effect.andThen(Effect.never),
              ),
        ready: (attempt) => (attempt === 1 ? Deferred.await(failedSnapshot) : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.stage === "synchronizing");
      yield* TestClock.adjust("60 seconds");
      yield* Deferred.fail(failedSnapshot, transient());
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");
      yield* supervisor.connect;
      yield* awaitState(supervisor.state, (state) => state.stage === "preparing");
      yield* TestClock.adjust("29 seconds");
      expect(yield* Ref.get(harness.prepareCount)).toBe(3);
      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(harness.prepareCount)).toBe(4);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps the no-answer watchdog at 15 seconds after learning a 45 second budget", () =>
    Effect.gen(function* () {
      const { supervisor, harness } = yield* learnSlowSetup(100_000, Effect.never);
      yield* supervisor.connect;
      yield* awaitState(supervisor.state, (state) => state.stage === "preparing");
      yield* TestClock.adjust("14 seconds");
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connecting");
      yield* TestClock.adjust("1 second");
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "backoff",
        attempt: 1,
        lastFailure: { reason: "timeout" },
      });
      expect(yield* Ref.get(harness.prepareCount)).toBe(3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "extends the learned deadline when authentication arrives before the silent watchdog",
    () =>
      Effect.gen(function* () {
        const answer = yield* Deferred.make<void>();
        const { supervisor, harness } = yield* learnSlowSetup(
          100_000,
          Effect.never,
          Deferred.await(answer),
        );
        yield* supervisor.connect;
        yield* awaitState(supervisor.state, (state) => state.stage === "preparing");
        yield* TestClock.adjust("10 seconds");
        yield* Deferred.succeed(answer, undefined);
        yield* TestClock.adjust("34 seconds");
        expect(yield* Ref.get(harness.prepareCount)).toBe(3);
        expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connecting");
        yield* TestClock.adjust("1 second");
        expect(yield* Ref.get(harness.prepareCount)).toBe(4);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "caps the per-route budget at 45 seconds even after a successful 100 second setup",
    () =>
      Effect.gen(function* () {
        const { supervisor, harness } = yield* learnSlowSetup(100_000, Effect.never, Effect.void);
        yield* supervisor.connect;
        yield* awaitState(supervisor.state, (state) => state.stage === "preparing");
        yield* TestClock.adjust("44 seconds");
        expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connecting");
        expect(yield* Ref.get(harness.prepareCount)).toBe(3);
        yield* TestClock.adjust("1 second");
        expect(yield* Ref.get(harness.prepareCount)).toBe(4);
        expect((yield* SubscriptionRef.get(supervisor.state)).lastFailure).toBeNull();
        yield* TestClock.adjust("45 seconds");
        expect(
          yield* awaitState(supervisor.state, (state) => state.phase === "backoff"),
        ).toMatchObject({ attempt: 1, lastFailure: { reason: "timeout" } });
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps the 15 second floor after fast setup and a slow snapshot", () =>
    Effect.gen(function* () {
      const snapshot = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (attempt) => (attempt === 1 ? Effect.succeed(PREPARED_CONNECTION) : Effect.never),
        ready: () => Deferred.await(snapshot),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.stage === "synchronizing");
      yield* TestClock.adjust("40 seconds");
      yield* Deferred.succeed(snapshot, undefined);
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");
      yield* supervisor.connect;
      yield* awaitState(supervisor.state, (state) => state.stage === "preparing");
      yield* TestClock.adjust("14 seconds");
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connecting");
      yield* TestClock.adjust("1 second");
      expect(
        yield* awaitState(supervisor.state, (state) => state.phase === "backoff"),
      ).toMatchObject({ attempt: 1, lastFailure: { reason: "timeout" } });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("forgets the old maximum after five newer successful setups", () =>
    Effect.gen(function* () {
      const stall = yield* Ref.make(false);
      const { supervisor, harness } = yield* learnSlowSetup(
        20_000,
        Ref.get(stall).pipe(
          Effect.flatMap((value) =>
            value ? Effect.never : Effect.succeed(preparedFor(RELAY_TARGET)),
          ),
        ),
        Effect.void,
      );
      for (let sample = 0; sample < 5; sample += 1) {
        yield* supervisor.connect;
        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        yield* supervisor.disconnect;
        yield* awaitState(supervisor.state, (state) => state.phase === "available");
      }
      yield* Ref.set(stall, true);
      yield* supervisor.connect;
      yield* awaitState(supervisor.state, (state) => state.stage === "preparing");
      yield* TestClock.adjust("15 seconds");
      expect(yield* Ref.get(harness.prepareCount)).toBe(9);
      yield* TestClock.adjust("15 seconds");
      expect(
        yield* awaitState(supervisor.state, (state) => state.phase === "backoff"),
      ).toMatchObject({ attempt: 1, lastFailure: { reason: "timeout" } });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("measures completion for a driver that never reports synchronizing", () =>
    Effect.gen(function* () {
      const finishSetup = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        reportSynchronizing: false,
        prepare: (attempt, _target, progress) =>
          attempt === 1
            ? Deferred.await(finishSetup).pipe(Effect.as(PREPARED_CONNECTION))
            : progress({ stage: "preparing", hostAnswered: true }).pipe(
                Effect.andThen(Effect.never),
              ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.stage === "preparing");
      yield* TestClock.adjust("12 seconds");
      yield* Deferred.succeed(finishSetup, undefined);
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");
      yield* supervisor.connect;
      yield* awaitState(supervisor.state, (state) => state.stage === "preparing");
      yield* TestClock.adjust("17 seconds");
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connecting");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(harness.prepareCount)).toBe(3);
      expect((yield* SubscriptionRef.get(supervisor.state)).lastFailure).toBeNull();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "immediately retries the first answered setup timeout, then escalates consecutive timeouts",
    () =>
      Effect.gen(function* () {
        const opened = yield* Ref.make(0);
        const secondOpened = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          prepare: (_attempt, _target, progress) =>
            progress({ stage: "preparing", hostAnswered: true }).pipe(
              Effect.andThen(Ref.updateAndGet(opened, (count) => count + 1)),
              Effect.flatMap((count) =>
                count === 2 ? Deferred.succeed(secondOpened, undefined) : Effect.void,
              ),
              Effect.andThen(Effect.never),
            ),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));
        yield* awaitState(supervisor.state, (state) => state.stage === "preparing");
        yield* TestClock.adjust("15 seconds");
        yield* Deferred.await(secondOpened);
        expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
          phase: "connecting",
          stage: "preparing",
          attempt: 1,
          lastFailure: null,
          retryAt: null,
        });
        yield* TestClock.adjust("15 seconds");
        const second = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
        expect(second.attempt).toBe(1);
        expect(second.retryAt! - (yield* Clock.currentTimeMillis)).toBe(2_000);
        yield* TestClock.adjust("2 seconds");
        yield* awaitState(
          supervisor.state,
          (state) => state.stage === "preparing" && state.attempt === 2,
        );
        yield* TestClock.adjust("15 seconds");
        const third = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
        expect(third.attempt).toBe(2);
        expect(third.retryAt! - (yield* Clock.currentTimeMillis)).toBe(4_000);
        expect(yield* Ref.get(harness.prepareCount)).toBe(3);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("counts silent setup timeouts and retains the retry ladder", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ prepare: () => Effect.never });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.stage === "preparing");
      yield* TestClock.adjust("15 seconds");
      const first = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      expect(first.attempt).toBe(1);
      expect(first.retryAt! - (yield* Clock.currentTimeMillis)).toBe(2_000);
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      yield* TestClock.adjust("2 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.stage === "preparing" && state.attempt === 2,
      );
      yield* TestClock.adjust("15 seconds");
      const second = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      expect(second.attempt).toBe(2);
      expect(second.retryAt! - (yield* Clock.currentTimeMillis)).toBe(4_000);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("EnvironmentSupervisor routes", () => {
  it.effect("skips a silent LAN route and connects over GOAT Connect", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          Effect.succeed(route.target._tag === "BearerConnectionTarget" ? "silent" : "unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.target._tag).toBe("RelayConnectionTarget");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );

  it.effect("moves to a blocked route's fallback instead of stopping", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("answered"),
        prepare: (_attempt, target) =>
          target._tag === "BearerConnectionTarget"
            ? Effect.fail(blocked("The environment credential is invalid."))
            : Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.target._tag).toBe("RelayConnectionTarget");
    }),
  );

  it.effect("tries every route when none answers the reachability check", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("silent"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.target._tag).toBe("BearerConnectionTarget");
    }),
  );

  it.effect("keeps retrying when one route is blocked and another failed transiently", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("answered"),
        prepare: (_attempt, target) =>
          target._tag === "RelayConnectionTarget"
            ? Effect.fail(blocked("Sign in to GOAT Connect."))
            : Effect.fail(transient("LAN socket refused.")),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      const state = yield* awaitState(supervisor.state, (value) => value.phase === "backoff");
      expect(state.lastFailure?._tag).toBe("ConnectionTransientError");
    }),
  );

  it.effect("moves back to the LAN route when the network changes and it answers again", () =>
    Effect.gen(function* () {
      const lanReachable = yield* Ref.make(false);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.get(lanReachable).pipe(
                Effect.map((reachable) => (reachable ? "answered" : "silent")),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "RelayConnectionTarget",
      );

      yield* Ref.set(lanReachable, true);
      yield* harness.setNetworkStatus("unknown");
      yield* harness.setNetworkStatus("online");

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("moves off a dead LAN socket when the phone switches to cellular", () =>
    Effect.gen(function* () {
      const lanReachable = yield* Ref.make(true);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.get(lanReachable).pipe(
                Effect.map((reachable) => (reachable ? "answered" : "silent")),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        probe: () =>
          Ref.get(lanReachable).pipe(
            Effect.flatMap((reachable) => (reachable ? Effect.void : Effect.never)),
          ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );

      yield* Ref.set(lanReachable, false);
      yield* harness.wake("network-changed");
      yield* TestClock.adjust("3 seconds");

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "RelayConnectionTarget",
      );
    }),
  );

  it.effect("learns the LAN address over GOAT Connect and moves to it", () =>
    Effect.gen(function* () {
      const relayEntry: ConnectionCatalogEntry = {
        target: RELAY_TARGET,
        profile: Option.none(),
        enabled: true,
      };
      const lanAddress = yield* Ref.make("http://192.168.1.10:3773/");
      const learned = yield* Ref.make<ReadonlyArray<string>>([]);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Effect.succeed("answered")
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        initialConfig: () =>
          Ref.get(lanAddress).pipe(
            Effect.map((httpBaseUrl): Pick<ServerConfig, "directEndpoints"> => ({
              directEndpoints: [{ kind: "lan", httpBaseUrl }],
            })),
            Effect.map((config) => config as ServerConfig),
          ),
      });
      const current = yield* Ref.make(relayEntry);
      const supervisor = yield* EnvironmentSupervisor.make(relayEntry, {
        initiallyDesired: true,
        learnRoutes: ({ activeRoute, reported }) =>
          Effect.gen(function* () {
            const entry = yield* Ref.get(current);
            const routes = mergeLearnedRoutes({
              entry,
              activeRoute,
              reported,
              allowInsecure: true,
            });
            if (routes === null) return Option.none();
            const next = entryWithRoutes(entry, routes);
            yield* Ref.set(current, next);
            yield* Ref.update(learned, (all) => [
              ...all,
              ...routes.filter(isLearned).map((route) => connectionRouteId(route.target)),
            ]);
            return Option.some(next);
          }),
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
      expect(yield* Ref.get(learned)).toEqual([
        `learned:${TARGET.environmentId}:http://192.168.1.10:3773`,
      ]);
    }),
  );
});

describe("EnvironmentSupervisor with SSH failures", () => {
  const unreachable = () =>
    sshPreparationFailure(
      new Error(
        "Cannot reach mbp over SSH (192.168.1.20:22: Operation timed out). Check the network or VPN connection to that host.",
      ),
    );

  it.effect("retries a sleeping host quietly, and at once when the network changes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt <= 3 ? Effect.fail(unreachable()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      for (const [index, delay] of [2_000, 4_000].entries()) {
        const waiting = yield* eventuallyState(
          supervisor.state,
          (state) => state.phase === "backoff" && state.attempt === index + 1,
        );
        expect(presentConnectionState(waiting)).toMatchObject({
          phase: "reconnecting",
          unreachable: true,
          retryAt: (yield* Clock.currentTimeMillis) + delay,
        });
        yield* TestClock.adjust(delay);
      }
      yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 3,
      );

      // The laptop joins a network: no need to sit out the 8 second rung.
      yield* harness.wake("network-changed");
      const connected = yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "connected",
      );
      expect(yield* Ref.get(harness.prepareCount)).toBe(4);
      expect(presentConnectionState(connected).unreachable).toBeUndefined();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("waits for the user after the host rejects the login", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1
            ? Effect.fail(
                sshPreparationFailure(new Error("julius@mbp: Permission denied (publickey).")),
              )
            : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* eventuallyState(supervisor.state, (state) => state.phase === "blocked");
      yield* TestClock.adjust("10 minutes");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);

      yield* supervisor.retryNow;
      yield* eventuallyState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("structural reconnect regressions", () => {
  it.effect(
    "keeps a long-resume replacement attempt running when an offline report arrives during establishment",
    () =>
      Effect.gen(function* () {
        const replacementStarted = yield* Deferred.make<void>();
        const allowReplacement = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          prepare: (attempt) =>
            attempt === 2
              ? Deferred.succeed(replacementStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(allowReplacement)),
                  Effect.as(PREPARED_CONNECTION),
                )
              : Effect.succeed(PREPARED_CONNECTION),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 1,
        );
        yield* harness.wake("application-active-reconnect");
        yield* Deferred.await(replacementStarted);

        // Wi-Fi briefly reports offline while re-associating on wake; the replacement attempt must continue.
        yield* harness.setNetworkStatus("offline");
        yield* TestClock.adjust(0);
        yield* Deferred.succeed(allowReplacement, undefined);

        yield* TestClock.adjust(0);
        const connected = yield* SubscriptionRef.get(supervisor.state);
        expect(connected).toMatchObject({ phase: "connected", generation: 2, attempt: 1 });
        expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("structural supervisor ownership", () => {
  it.effect("publishes the reset attempt after the stability window", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* TestClock.adjust(2_000);
      expect(
        (yield* awaitState(supervisor.state, (state) => state.phase === "connected")).attempt,
      ).toBe(2);
      yield* TestClock.adjust(30_000);
      expect((yield* SubscriptionRef.get(supervisor.state)).attempt).toBe(1);
      yield* harness.closeLatestSession();
      const failed = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      expect(failed.attempt).toBe(1);
      expect(failed.retryAt! - (yield* Clock.currentTimeMillis)).toBe(2_000);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["application-active-reconnect", "application-active-probe"] as const)(
    "absorbs %s, network change and Retry now into one gated driver.connect",
    (reason) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          prepare: (attempt) =>
            attempt === 1
              ? Effect.fail(transient())
              : Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.as(PREPARED_CONNECTION),
                ),
        });
        let connectCalls = 0;
        const baseDriver = yield* ConnectionDriver.ConnectionDriver.pipe(
          Effect.provide(harness.dependencies),
        );
        const dependencies = Layer.merge(
          harness.dependencies,
          Layer.succeed(ConnectionDriver.ConnectionDriver, {
            ...baseDriver,
            connect: (entry, progress) =>
              Effect.sync(() => {
                connectCalls += 1;
              }).pipe(Effect.andThen(baseDriver.connect(entry, progress))),
          }),
        );
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(dependencies));
        yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
        yield* Effect.all(
          [harness.wake(reason), harness.wake("network-changed"), supervisor.retryNow],
          { concurrency: "unbounded" },
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust(0);
        expect(connectCalls).toBe(2);
        yield* Deferred.succeed(gate, undefined);
        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        yield* TestClock.adjust(0);
        expect(connectCalls).toBe(2);
        yield* harness.closeLatestSession();
        const failed = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
        expect(failed.attempt).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("fences interrupted and finished progress after replacement and disconnect", () =>
    Effect.gen(function* () {
      const reports: Array<
        (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>
      > = [];
      const started = yield* Deferred.make<void>();
      const base = yield* makeHarness();
      const baseDriver = yield* ConnectionDriver.ConnectionDriver.pipe(
        Effect.provide(base.dependencies),
      );
      const driver = {
        ...baseDriver,
        connect: (
          entry: ConnectionCatalogEntry,
          report: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
        ) =>
          Effect.gen(function* () {
            reports.push(report);
            if (reports.length === 1) {
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }
            return yield* baseDriver.connect(entry, report);
          }),
      };
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provide(
          Layer.merge(base.dependencies, Layer.succeed(ConnectionDriver.ConnectionDriver, driver)),
        ),
      );
      yield* Deferred.await(started);
      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");
      yield* supervisor.connect;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const before = yield* SubscriptionRef.get(supervisor.state);
      const prepared = yield* SubscriptionRef.get(supervisor.prepared);
      for (const report of reports)
        yield* report({
          stage: "opening",
          prepared: { ...PREPARED_CONNECTION, httpBaseUrl: "https://stale.test" },
        });
      expect(yield* SubscriptionRef.get(supervisor.state)).toEqual(before);
      expect(yield* SubscriptionRef.get(supervisor.prepared)).toEqual(prepared);
      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");
      for (const report of reports)
        yield* report({ stage: "opening", prepared: PREPARED_CONNECTION });
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("available");
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
    }),
  );

  it.effect("cancels an in-flight better-route preflight with its connected lease", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      let check = false;
      const harness = yield* makeHarness({
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? check
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
                )
              : Effect.succeed("silent" as const)
            : Effect.succeed("unchecked" as const),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      check = true;
      yield* harness.wake("network-changed");
      yield* Deferred.await(started);
      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");
      expect(yield* Deferred.isDone(stopped)).toBe(true);
    }),
  );
});

describe("targeted establishment replacement", () => {
  it.effect.each(["preparing", "synchronizing"] as const)(
    "replaces a pre-resume attempt stalled at %s",
    (stage) =>
      Effect.gen(function* () {
        const stalled = yield* Deferred.make<void>();
        const stall = Deferred.succeed(stalled, undefined).pipe(Effect.andThen(Effect.never));
        const harness = yield* makeHarness({
          prepare: (attempt) =>
            stage === "preparing" && attempt === 2 ? stall : Effect.succeed(PREPARED_CONNECTION),
          ready: (attempt) => (stage === "synchronizing" && attempt === 2 ? stall : Effect.void),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));
        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        yield* harness.closeLatestSession();
        yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
        yield* TestClock.adjust(2_000);
        yield* Deferred.await(stalled);
        yield* harness.wake("application-active-reconnect");
        yield* TestClock.adjust(0);
        expect(yield* Ref.get(harness.prepareCount)).toBe(3);
        expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
          phase: "connected",
          generation: 2,
          attempt: 1,
        });
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("an explicit retry restarts a stalled attempt without waiting for its timeout", () =>
    Effect.gen(function* () {
      const stalled = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 2
            ? Deferred.succeed(stalled, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* TestClock.adjust(2_000);
      yield* Deferred.await(stalled);
      yield* supervisor.retryNow;
      yield* TestClock.adjust(0);
      expect(yield* Ref.get(harness.prepareCount)).toBe(3);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 2,
        attempt: 1,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["retry", "application-active-probe", "application-active-reconnect"] as const)(
    "a later Retry replaces a stalled attempt started by %s",
    (source) =>
      Effect.gen(function* () {
        const stalled = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          prepare: (attempt) =>
            attempt === 1
              ? Effect.fail(transient())
              : attempt === 2
                ? Deferred.succeed(stalled, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed(PREPARED_CONNECTION),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));
        yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
        yield* source === "retry" ? supervisor.retryNow : harness.wake(source);
        yield* Deferred.await(stalled);
        // Ordering comes from the driver's milestone, even when the clock has not moved.
        yield* supervisor.retryNow;
        yield* TestClock.adjust(0);
        expect(yield* Ref.get(harness.prepareCount)).toBe(3);
        expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
          phase: "connected",
          attempt: 1,
        });
      }).pipe(Effect.provide(TestClock.layer())),
  );
});

it.effect("coalesces concurrent replacement requests targeting a stalled attempt", () =>
  Effect.gen(function* () {
    const originalStarted = yield* Deferred.make<void>();
    const replacementStarted = yield* Deferred.make<void>();
    const allowReplacement = yield* Deferred.make<void>();
    const harness = yield* makeHarness({
      prepare: (attempt) =>
        attempt === 1
          ? Deferred.succeed(originalStarted, undefined).pipe(Effect.andThen(Effect.never))
          : Deferred.succeed(replacementStarted, undefined).pipe(
              Effect.andThen(Deferred.await(allowReplacement)),
              Effect.as(PREPARED_CONNECTION),
            ),
    });
    const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
      initiallyDesired: true,
    }).pipe(Effect.provide(harness.dependencies));
    yield* Deferred.await(originalStarted);
    yield* Effect.all(
      [
        harness.wake("application-active-reconnect"),
        harness.wake("network-changed"),
        supervisor.retryNow,
      ],
      { concurrency: "unbounded" },
    );
    yield* TestClock.adjust(0);
    expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    expect(yield* Deferred.isDone(replacementStarted)).toBe(true);
    yield* Deferred.succeed(allowReplacement, undefined);
    yield* TestClock.adjust(0);
    expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
    expect(yield* Ref.get(harness.prepareCount)).toBe(2);
  }).pipe(Effect.provide(TestClock.layer())),
);

describe("suspend recovery review regressions", () => {
  it.effect.each(["preparing", "synchronizing"] as const)(
    "publishes an idle state after suspend cancels %s",
    (stage) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          prepare: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(
                stage === "preparing" ? Effect.never : Effect.succeed(PREPARED_CONNECTION),
              ),
            ),
          ready: () => Effect.never,
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));
        yield* Deferred.await(started);
        yield* awaitState(supervisor.state, (state) => state.stage === stage);
        yield* harness.wake("suspend");
        yield* TestClock.adjust(0);
        expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
          desired: true,
          phase: "offline",
          stage: null,
          retryAt: null,
          lastFailure: null,
        });
        expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);
        expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["connect", "retry", "disconnect-connect", "online", "network-wakeup"] as const)(
    "%s recovers when suspend has no matching resume",
    (source) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          ready: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));
        yield* awaitState(supervisor.state, (state) => state.stage === "synchronizing");
        yield* harness.wake("suspend");
        yield* TestClock.adjust("1 minute");
        expect(yield* Ref.get(harness.prepareCount)).toBe(1);
        switch (source) {
          case "connect":
            yield* supervisor.connect;
            break;
          case "retry":
            yield* supervisor.retryNow;
            break;
          case "disconnect-connect":
            yield* supervisor.disconnect;
            yield* TestClock.adjust(0);
            yield* supervisor.connect;
            break;
          case "online":
            yield* harness.setNetworkStatus("offline");
            yield* TestClock.adjust(0);
            yield* harness.setNetworkStatus("online");
            break;
          case "network-wakeup":
            yield* harness.wake("network-changed");
            break;
        }
        yield* TestClock.adjust(0);
        expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
          phase: "connected",
          stage: null,
          attempt: 1,
          lastFailure: null,
        });
        expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("preserves long resume consumed while suspended and offline", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        ready: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.stage === "synchronizing");
      yield* harness.wake("suspend");
      yield* TestClock.adjust(0);
      yield* harness.setNetworkStatus("offline");
      yield* TestClock.adjust("1 minute");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      yield* harness.wake("application-active-reconnect");
      yield* TestClock.adjust(0);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        network: "offline",
        attempt: 1,
        lastFailure: null,
      });
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each([3_600_000, -3_600_000])(
    "measures the wake window monotonically across a %s ms wall clock shift",
    (offset) =>
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        let wallOffset = 0;
        const shiftedClock: Clock.Clock = {
          ...clock,
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + wallOffset,
          currentTimeMillis: clock.currentTimeMillis.pipe(Effect.map((now) => now + wallOffset)),
        };
        const harness = yield* makeHarness({
          random: 0.25,
          prepare: () => Effect.fail(transient()),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(
          Effect.provide(harness.dependencies),
          Effect.provideService(Clock.Clock, shiftedClock),
        );
        yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
        yield* harness.wake("application-active-reconnect");
        yield* TestClock.adjust(0);
        wallOffset = offset;
        for (let elapsed = 2_000; elapsed < 30_000; elapsed += 2_000) {
          yield* TestClock.adjust(2_000);
          const retrying = yield* SubscriptionRef.get(supervisor.state);
          expect(retrying).toMatchObject({ phase: "backoff", attempt: 1 });
          expect(retrying.retryAt).toBe(elapsed + offset + 2_000);
        }
        yield* TestClock.adjust(1_999);
        expect(yield* Ref.get(harness.prepareCount)).toBe(16);
        yield* TestClock.adjust(1);
        expect((yield* SubscriptionRef.get(supervisor.state)).retryAt).toBe(
          30_000 + offset + 1_250,
        );
        yield* TestClock.adjust(1_250);
        expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
          phase: "backoff",
          attempt: 2,
          retryAt: 31_250 + offset + 2_500,
        });
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["connected", "disconnected"] as const)(
    "clears the wake retry window once %s",
    (transition) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          random: 0.25,
          prepare: (attempt) =>
            transition === "connected" && attempt === 2
              ? Effect.succeed(PREPARED_CONNECTION)
              : Effect.fail(transient()),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));
        yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
        yield* harness.wake("application-active-reconnect");
        yield* TestClock.adjust(0);
        if (transition === "connected") {
          expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
          yield* harness.closeLatestSession();
        } else {
          yield* supervisor.disconnect;
          yield* TestClock.adjust(0);
          expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("available");
          yield* supervisor.connect;
        }
        yield* TestClock.adjust(0);
        expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
          phase: "backoff",
          attempt: 1,
          retryAt: 1_250,
        });
        yield* TestClock.adjust(1_250);
        expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
          phase: "backoff",
          attempt: 2,
          retryAt: 3_750,
        });
      }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("SSH preparation lifetime and provenance", () => {
  const sshTarget = new SshConnectionTarget({
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    connectionId: "ssh:fixture",
  });
  const sshEntry: ConnectionCatalogEntry = {
    target: sshTarget,
    profile: Option.none(),
    enabled: true,
  };
  const phase = (
    overrides: Partial<DesktopSshPreparationProgress> = {},
  ): DesktopSshPreparationProgress => ({
    operationId: "flight-1",
    phase: "uploading",
    hostAnswered: true,
    remainingMs: 900_000,
    ...overrides,
  });
  const ready = phase({
    phase: null,
    outcome: "ready",
    attachmentId: "attachment-1",
    runtimeStatus: {
      host: "fixture",
      state: "ready",
      runtimeVersion: null,
      requestedVersion: "1.0.0",
    },
  });

  const held = Effect.fn("SshLifetimeFixture.held")(function* (options?: {
    readonly reportSynchronizing?: boolean;
    readonly ready?: Effect.Effect<void, ConnectionAttemptError>;
    readonly entry?: ConnectionCatalogEntry;
  }) {
    const callers = yield* Queue.unbounded<{
      attempt: number;
      report: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>;
    }>();
    const release = yield* Deferred.make<void>();
    const harness = yield* makeHarness({
      prepare: (attempt, target, report) =>
        Queue.offer(callers, { attempt, report }).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(preparedFor(target)),
        ),
      ...(options?.reportSynchronizing === undefined
        ? {}
        : { reportSynchronizing: options.reportSynchronizing }),
      ...(options?.ready === undefined ? {} : { ready: () => options.ready! }),
    });
    const supervisor = yield* EnvironmentSupervisor.make(options?.entry ?? sshEntry, {
      initiallyDesired: true,
    }).pipe(Effect.provide(harness.dependencies));
    const first = yield* Queue.take(callers);
    const report = (value: DesktopSshPreparationProgress) =>
      first.report({ stage: "preparing", routeId: sshTarget.connectionId, sshPreparation: value });
    return { harness, supervisor, callers, release, first, report };
  });

  it.effect(
    "keeps one answered 258 second installation alive, then excludes it from ordinary setup samples",
    () =>
      Effect.gen(function* () {
        const f = yield* held();
        yield* f.report(phase());
        yield* TestClock.adjust("258 seconds");
        expect(yield* Ref.get(f.harness.prepareCount)).toBe(1);
        expect(yield* SubscriptionRef.get(f.supervisor.state)).toMatchObject({
          phase: "connecting",
          attempt: 1,
          lastFailure: null,
          sshPreparation: { phase: "uploading", routeId: "ssh:fixture", attemptId: 1 },
        });
        yield* f.report(ready);
        expect((yield* SubscriptionRef.get(f.supervisor.state)).sshPreparation).toBeUndefined();
        expect((yield* SubscriptionRef.get(f.supervisor.state)).sshRuntimeReady).toMatchObject({
          attachmentId: "attachment-1",
          attemptId: 1,
        });
        yield* Deferred.succeed(f.release, undefined);
        yield* awaitState(f.supervisor.state, (state) => state.phase === "connected");
        yield* f.supervisor.disconnect;
        yield* awaitState(f.supervisor.state, (state) => state.phase === "available");
        yield* f.supervisor.connect;
        yield* awaitState(f.supervisor.state, (state) => state.phase === "connected");
        expect((yield* SubscriptionRef.get(f.supervisor.state)).sshRuntimeReady).toBeUndefined();
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("wakes a sleeping 15 second deadline when the final host answers just before it", () =>
    Effect.gen(function* () {
      const f = yield* held();
      yield* f.report(phase({ phase: "connecting", hostAnswered: false }));
      yield* TestClock.adjust(14_999);
      yield* f.report(phase({ phase: "checking", remainingMs: 885_001 }));
      yield* TestClock.adjust(243_001);
      expect(yield* Ref.get(f.harness.prepareCount)).toBe(1);
      expect((yield* SubscriptionRef.get(f.supervisor.state)).lastFailure).toBeNull();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each([false, true])(
    "does not extend unanswered or jump-host-only progress (answered=%s)",
    (answered) =>
      Effect.gen(function* () {
        const f = yield* held();
        yield* f.report(
          phase({ phase: answered ? "connecting" : "uploading", hostAnswered: answered }),
        );
        yield* TestClock.adjust(14_999);
        expect(yield* Ref.get(f.harness.prepareCount)).toBe(1);
        yield* TestClock.adjust(1);
        if (answered) yield* TestClock.adjust("15 seconds");
        yield* awaitState(f.supervisor.state, (state) => state.phase === "backoff");
        expect(yield* Ref.get(f.harness.prepareCount)).toBe(answered ? 2 : 1);
        // Answered-only legacy timing still has its existing one free slow-setup retry.
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("clamps repeated progress, Retry and replay to the original 900 second lifetime", () =>
    Effect.gen(function* () {
      const f = yield* held();
      yield* f.report(phase());
      yield* TestClock.adjust("60 seconds");
      yield* f.supervisor.retryNow;
      const second = yield* Queue.take(f.callers);
      yield* second.report({
        stage: "preparing",
        routeId: sshTarget.connectionId,
        sshPreparation: phase({ phase: "starting" }),
      });
      // Old waiters and mismatched operations cannot extend the current flight.
      yield* f.report(phase({ operationId: "stale-other-operation" }));
      yield* second.report({
        stage: "preparing",
        routeId: sshTarget.connectionId,
        sshPreparation: phase({ operationId: "foreign-flight" }),
      });
      expect((yield* SubscriptionRef.get(f.supervisor.state)).sshPreparation?.operationId).toBe(
        "flight-1",
      );
      yield* TestClock.adjust("839 seconds");
      expect(yield* Ref.get(f.harness.prepareCount)).toBe(2);
      yield* second.report({
        stage: "preparing",
        routeId: sshTarget.connectionId,
        sshPreparation: phase(),
      });
      yield* TestClock.adjust("1 second");
      const failed = yield* awaitState(f.supervisor.state, (state) => state.phase === "backoff");
      expect(failed).toMatchObject({
        attempt: 1,
        lastFailure: { reason: "timeout", sshPreparationTimedOut: true },
        failureOrigin: { attemptId: 2, routeId: "ssh:fixture", setupTimeout: true },
      });
      expect(failed.sshPreparation).toBeUndefined();
      expect(yield* Ref.get(f.harness.prepareCount)).toBe(2);
      yield* TestClock.adjust(1_999);
      expect(yield* Ref.get(f.harness.prepareCount)).toBe(2);
      yield* TestClock.adjust(1);
      expect((yield* Queue.take(f.callers)).attempt).toBe(3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "restores ordinary opening immediately after terminal and cannot replay an ended operation",
    () =>
      Effect.gen(function* () {
        const f = yield* held();
        yield* f.report(phase());
        yield* TestClock.adjust("258 seconds");
        yield* f.report(ready);
        yield* f.report(phase());
        expect((yield* SubscriptionRef.get(f.supervisor.state)).sshPreparation).toBeUndefined();
        yield* TestClock.adjust(10_000);
        yield* f.report(ready);
        yield* TestClock.adjust(4_999);
        expect(yield* Ref.get(f.harness.prepareCount)).toBe(1);
        yield* TestClock.adjust(1);
        expect(yield* Ref.get(f.harness.prepareCount)).toBe(2);
        yield* TestClock.adjust("15 seconds");
        const failed = yield* awaitState(f.supervisor.state, (state) => state.phase === "backoff");
        expect(failed.lastFailure).toMatchObject({ reason: "timeout" });
        expect(failed.lastFailure).not.toHaveProperty("sshPreparationTimedOut");
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["superseded", "failed"] as const)(
    "invalidates ready while pairing is pending on %s without renewing opening time",
    (outcome) =>
      Effect.gen(function* () {
        const f = yield* held();
        yield* f.report(phase());
        yield* f.report(ready);
        expect((yield* SubscriptionRef.get(f.supervisor.state)).sshRuntimeReady).toBeDefined();
        yield* TestClock.adjust("10 seconds");
        const invalidated = yield* Deferred.make<void>();
        const invalidate = yield* Deferred.make<void>();
        yield* Deferred.await(invalidate).pipe(
          Effect.andThen(f.report(phase({ phase: null, outcome }))),
          Effect.andThen(Deferred.succeed(invalidated, undefined)),
          Effect.forkScoped,
        );
        yield* Deferred.succeed(invalidate, undefined);
        yield* Deferred.await(invalidated);
        expect((yield* SubscriptionRef.get(f.supervisor.state)).sshRuntimeReady).toBeUndefined();
        yield* f.report(ready);
        yield* f.report(phase());
        expect((yield* SubscriptionRef.get(f.supervisor.state)).sshRuntimeReady).toBeUndefined();
        expect((yield* SubscriptionRef.get(f.supervisor.state)).sshPreparation).toBeUndefined();
        yield* TestClock.adjust(4_999);
        expect(yield* Ref.get(f.harness.prepareCount)).toBe(1);
        yield* TestClock.adjust(1);
        expect((yield* Queue.take(f.callers)).attempt).toBe(2);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("ignores ended reports once a new operation owns the route", () =>
    Effect.gen(function* () {
      const f = yield* held();
      yield* f.report(phase());
      yield* f.report(ready);
      yield* f.report(phase({ operationId: "flight-2" }));
      yield* f.report({ ...ready, operationId: "flight-2" });
      yield* f.report(phase({ phase: null, outcome: "superseded" }));
      yield* f.report(phase());
      const state = yield* SubscriptionRef.get(f.supervisor.state);
      expect(state.sshRuntimeReady?.operationId).toBe("flight-2");
      expect(state.sshPreparation).toBeUndefined();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "gives opening its allowance and then keeps the existing 75 second snapshot budget",
    () =>
      Effect.gen(function* () {
        const snapshot = yield* Deferred.make<void>();
        const f = yield* held({ ready: Deferred.await(snapshot) });
        yield* f.report(phase());
        yield* TestClock.adjust("258 seconds");
        yield* f.report(ready);
        yield* TestClock.adjust("14 seconds");
        yield* Deferred.succeed(f.release, undefined);
        yield* awaitState(f.supervisor.state, (state) => state.stage === "synchronizing");
        yield* TestClock.adjust("75 seconds");
        expect((yield* SubscriptionRef.get(f.supervisor.state)).stage).toBe("synchronizing");
        yield* Deferred.succeed(snapshot, undefined);
        yield* awaitState(f.supervisor.state, (state) => state.phase === "connected");
        expect(yield* Ref.get(f.harness.prepareCount)).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "does not let a late phase or jump-host answer from an old route extend a silent fallback",
    () =>
      Effect.gen(function* () {
        const f = yield* held({ entry: { ...sshEntry, alternateRoutes: [LAN_ROUTE] } });
        yield* f.report(phase());
        yield* f.first.report({ stage: "preparing", routeId: LAN_TARGET.connectionId });
        yield* f.report(phase());
        yield* f.first.report({
          stage: "preparing",
          routeId: sshTarget.connectionId,
          hostAnswered: true,
        });
        yield* TestClock.adjust("30 seconds");
        const failed = yield* awaitState(f.supervisor.state, (state) => state.phase === "backoff");
        expect(failed.failureOrigin).toMatchObject({ routeId: LAN_TARGET.connectionId });
        expect(yield* Ref.get(f.harness.prepareCount)).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("counts native preparation expiry once without a free setup retry", () =>
    Effect.gen(function* () {
      const expire = yield* Deferred.make<PreparedConnection, ConnectionAttemptError>();
      const reported = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (_attempt, _target, report) =>
          report({
            stage: "preparing",
            routeId: sshTarget.connectionId,
            sshPreparation: phase(),
          }).pipe(
            Effect.andThen(Deferred.succeed(reported, undefined)),
            Effect.andThen(Deferred.await(expire)),
          ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(sshEntry, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* Deferred.await(reported);
      yield* TestClock.adjust(899_999);
      yield* Deferred.fail(
        expire,
        sshPreparationFailure("SSH runtime preparation exceeded its 15-minute limit."),
      );
      const failed = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      expect(failed).toMatchObject({ attempt: 1, lastFailure: { sshPreparationTimedOut: true } });
      yield* TestClock.adjust(1);
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      expect((yield* SubscriptionRef.get(supervisor.state)).attempt).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "drops a superseded attempt without a failure/backoff increment and still permits disabling",
    () =>
      Effect.gen(function* () {
        const resumed = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          prepare: (attempt, target) =>
            attempt === 1
              ? Effect.fail(
                  new ConnectionAttemptSuperseded({
                    reason: "superseded",
                    detail: "Newer intent.",
                  }),
                )
              : Deferred.succeed(resumed, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.as(preparedFor(target)),
                ),
        });
        const supervisor = yield* EnvironmentSupervisor.make(sshEntry, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));
        yield* Deferred.await(resumed);
        expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
          phase: "connecting",
          attempt: 1,
          lastFailure: null,
          retryAt: null,
        });
        yield* supervisor.disconnect;
        const stopped = yield* awaitState(supervisor.state, (state) => state.phase === "available");
        expect(stopped.lastFailure).toBeNull();
        expect(stopped.sshRuntimeReady).toBeUndefined();
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "accepts validated terminal replay for a new waiter without reactivating its ended phase",
    () =>
      Effect.gen(function* () {
        const f = yield* held();
        yield* f.report(phase());
        yield* f.report(ready);
        yield* f.supervisor.retryNow;
        const second = yield* Queue.take(f.callers);
        yield* second.report({
          stage: "preparing",
          routeId: sshTarget.connectionId,
          sshPreparation: ready,
        });
        expect((yield* SubscriptionRef.get(f.supervisor.state)).sshRuntimeReady).toMatchObject({
          attemptId: 2,
          operationId: "flight-1",
        });
        yield* second.report({
          stage: "preparing",
          routeId: sshTarget.connectionId,
          sshPreparation: phase(),
        });
        expect((yield* SubscriptionRef.get(f.supervisor.state)).sshPreparation).toBeUndefined();
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each([false, true])(
    "starts zero new ensures during a 240 second healthy dwell (fallback=%s)",
    (fallback) =>
      Effect.gen(function* () {
        const requestGate = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        let connected = false;
        let checks = 0;
        let oldCompletions = 0;
        const oldCompletion = yield* Deferred.make<void>();
        const oldCompleted = yield* Deferred.make<void>();
        yield* Deferred.await(oldCompletion).pipe(
          Effect.andThen(
            Effect.sync(() => {
              oldCompletions++;
            }),
          ),
          Effect.andThen(Deferred.succeed(oldCompleted, undefined)),
          Effect.forkScoped,
        );
        const harness = yield* makeHarness({
          prepare: (_attempt, target) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(requestGate)),
              Effect.as(preparedFor(target)),
            ),
          checkRoute: (route) =>
            Effect.sync(() => {
              if (route.target._tag === "SshConnectionTarget") {
                checks++;
                return connected ? "unchecked" : fallback ? "silent" : "unchecked";
              }
              return "answered";
            }),
        });
        const supervisor = yield* EnvironmentSupervisor.make(
          fallback ? { ...sshEntry, alternateRoutes: [LAN_ROUTE] } : sshEntry,
          { initiallyDesired: true },
        ).pipe(Effect.provide(harness.dependencies));
        yield* Deferred.await(entered);
        yield* TestClock.adjust(235);
        yield* Deferred.succeed(requestGate, undefined);
        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        connected = true;
        const startsAtReady = yield* Ref.get(harness.prepareCount);
        for (let tick = 0; tick < 4; tick++) {
          yield* TestClock.adjust("60 seconds");
          expect(yield* Ref.get(harness.prepareCount)).toBe(startsAtReady);
        }
        yield* Deferred.succeed(oldCompletion, undefined);
        yield* Deferred.await(oldCompleted);
        expect(oldCompletions).toBe(1);
        expect(yield* Ref.get(harness.prepareCount)).toBe(startsAtReady);
        expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
        expect((yield* SubscriptionRef.get(supervisor.state)).attempt).toBe(1);
        if (fallback) expect(checks).toBeGreaterThanOrEqual(4);
      }).pipe(Effect.provide(TestClock.layer())),
  );
});

it.effect(
  "excludes a 258 second native preparation from later ordinary adaptive setup samples",
  () =>
    Effect.gen(function* () {
      const target = new SshConnectionTarget({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        connectionId: "ssh:sample",
      });
      const release = yield* Deferred.make<void>();
      const starts = yield* Queue.unbounded<number>();
      const harness = yield* makeHarness({
        prepare: (attempt, route, report) =>
          Effect.gen(function* () {
            yield* Queue.offer(starts, attempt);
            if (attempt > 1) {
              yield* report({
                stage: "preparing",
                routeId: target.connectionId,
                hostAnswered: true,
              });
              return yield* Effect.never;
            }
            yield* report({
              stage: "preparing",
              routeId: target.connectionId,
              sshPreparation: {
                operationId: "sample-flight",
                phase: "uploading",
                hostAnswered: true,
                remainingMs: 900_000,
              },
            });
            yield* Deferred.await(release);
            yield* report({
              stage: "preparing",
              routeId: target.connectionId,
              sshPreparation: {
                operationId: "sample-flight",
                phase: null,
                hostAnswered: true,
                remainingMs: 642_000,
                outcome: "ready",
                attachmentId: "sample-attachment",
                runtimeStatus: {
                  host: "fixture",
                  state: "ready",
                  runtimeVersion: null,
                  requestedVersion: "1.0.0",
                },
              },
            });
            return preparedFor(route);
          }),
      });
      const supervisor = yield* EnvironmentSupervisor.make(
        { target, profile: Option.none(), enabled: true },
        { initiallyDesired: true },
      ).pipe(Effect.provide(harness.dependencies));
      expect(yield* Queue.take(starts)).toBe(1);
      yield* TestClock.adjust("258 seconds");
      yield* Deferred.succeed(release, undefined);
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");
      yield* supervisor.connect;
      expect(yield* Queue.take(starts)).toBe(2);
      yield* TestClock.adjust(14_999);
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      yield* TestClock.adjust(1);
      expect(yield* Queue.take(starts)).toBe(3);
    }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("retains a displayed failure's origin while an uncounted slow-setup retry runs", () =>
  Effect.gen(function* () {
    const target = new SshConnectionTarget({
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      connectionId: "ssh:failure-origin",
    });
    const starts = yield* Queue.unbounded<number>();
    const harness = yield* makeHarness({
      prepare: (attempt, _target, report) =>
        Effect.gen(function* () {
          if (attempt > 1)
            yield* report({ stage: "preparing", routeId: target.connectionId, hostAnswered: true });
          yield* Queue.offer(starts, attempt);
          return yield* Effect.never;
        }),
    });
    const supervisor = yield* EnvironmentSupervisor.make(
      { target, profile: Option.none(), enabled: true },
      { initiallyDesired: true },
    ).pipe(Effect.provide(harness.dependencies));
    expect(yield* Queue.take(starts)).toBe(1);
    yield* TestClock.adjust("15 seconds");
    const original = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
    expect(original.failureOrigin?.attemptId).toBe(1);
    yield* TestClock.adjust("2 seconds");
    expect(yield* Queue.take(starts)).toBe(2);
    yield* TestClock.adjust("15 seconds");
    expect(yield* Queue.take(starts)).toBe(3);
    const retry = yield* SubscriptionRef.get(supervisor.state);
    expect(retry.lastFailure).toEqual(original.lastFailure);
    expect(retry.failureOrigin).toEqual(original.failureOrigin);
    yield* TestClock.adjust("15 seconds");
    expect(
      (yield* awaitState(supervisor.state, (state) => state.phase === "backoff")).failureOrigin
        ?.attemptId,
    ).toBe(3);
  }).pipe(Effect.provide(TestClock.layer())),
);
