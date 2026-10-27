import { vi } from "vite-plus/test";
vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));
import { describe, expect, it } from "@effect/vitest";
import type { ServerConfig } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import { BearerConnectionProfile } from "./catalog.ts";
import type * as ConnectionDriver from "./driver.ts";
import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  type ConnectionAttemptError,
  type ConnectionTarget,
  type PreparedConnection,
} from "./model.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { TARGET, PREPARED_CONNECTION, awaitState, makeHarness } from "./supervisorTestSupport.ts";
const TARGET_ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.none(),
  enabled: true,
};
const RELAY_ENTRY: ConnectionCatalogEntry = {
  target: new RelayConnectionTarget({ environmentId: TARGET.environmentId, label: TARGET.label }),
  profile: Option.none(),
  enabled: true,
};
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
function preparedFor(target: ConnectionTarget): PreparedConnection {
  return { ...PREPARED_CONNECTION, target };
}
const LAN_ENTRY: ConnectionCatalogEntry = {
  target: LAN_ROUTE.target,
  profile: LAN_ROUTE.profile,
  enabled: true,
};
const PROBE_CAPABLE_CONFIG = {
  environment: { capabilities: { connectionProbe: true } },
} as ServerConfig;

describe("connected lease liveness", () => {
  const makeSilentSocketHarness = (options?: {
    readonly probe?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
    readonly checkHost?: (check: number) => ConnectionDriver.RouteCheck;
  }) =>
    Effect.gen(function* () {
      const hostChecks = yield* Ref.make<ReadonlyArray<string>>([]);
      const harness = yield* makeHarness({
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        initialConfig: () => Effect.succeed(PROBE_CAPABLE_CONFIG),
        probe: options?.probe ?? ((attempt) => (attempt === 1 ? Effect.never : Effect.void)),
        checkHost: (prepared) =>
          Ref.updateAndGet(hostChecks, (checks) => [...checks, prepared.target._tag]).pipe(
            Effect.map((checks) => options?.checkHost?.(checks.length) ?? "answered"),
          ),
      });
      return { ...harness, hostChecks };
    });

  it.effect.each(["application-active-probe", "application-active-long"] as const)(
    "replaces a LAN socket that stays silent while its host answers afresh (%s)",
    (wakeup) =>
      Effect.gen(function* () {
        const harness = yield* makeSilentSocketHarness();
        const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        yield* harness.wake(wakeup);
        yield* TestClock.adjust("499 millis");
        expect(yield* Ref.get(harness.sessionCount)).toBe(1);

        yield* TestClock.adjust("1 millis");
        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 2,
        );
        expect(yield* Ref.get(harness.hostChecks)).toEqual(["BearerConnectionTarget"]);
        expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces a remote socket only after 2.5 seconds of silence", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness();
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("2499 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(yield* Ref.get(harness.hostChecks)).toEqual(["RelayConnectionTarget"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces a silent socket even while the network reports offline", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness();
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.setNetworkStatus("offline");
      yield* TestClock.adjust("500 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces a remote socket after a long resume while the network reports offline", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness();
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.setNetworkStatus("offline");
      yield* harness.wake("application-active-long");
      yield* TestClock.adjust("2500 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("checks the host afresh when the network changes after a frame", () =>
    Effect.gen(function* () {
      const frames = yield* Ref.make(0);
      const harness = yield* makeHarness({
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        initialConfig: () => Effect.succeed(PROBE_CAPABLE_CONFIG),
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
        inboundFrames: Ref.get(frames),
        checkHost: () => Effect.succeed("answered"),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("1 second");
      yield* Ref.update(frames, (count) => count + 1);
      yield* TestClock.adjust("1 second");
      yield* harness.wake("network-changed");
      // The running check sees the frame at 2.5 s, so a fresh one starts then.
      yield* TestClock.adjust("2999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps a running check's window when the network changes during a long resume", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness();
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-long");
      yield* TestClock.adjust("1 second");
      yield* harness.wake("network-changed");
      yield* harness.setNetworkStatus("offline");
      yield* TestClock.adjust("1500 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("checks the host again when one check goes unanswered", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness({
        checkHost: (check) => (check === 1 ? "silent" : "answered"),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("1499 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(yield* Ref.get(harness.hostChecks)).toHaveLength(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("leaves a web or desktop foreground probe to its own deadline", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness({
        probe: (attempt) => (attempt === 1 ? Effect.sleep("4 seconds") : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* TestClock.adjust("20 seconds");

      expect(yield* Ref.get(harness.hostChecks)).toEqual([]);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("checks the host when a network change arrives during a foreground probe", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness();
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* TestClock.adjust("100 millis");
      yield* harness.wake("network-changed");
      yield* TestClock.adjust("499 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps waiting for the probe when a frame arrives during the host check", () =>
    Effect.gen(function* () {
      const frames = yield* Ref.make(0);
      const harness = yield* makeHarness({
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        initialConfig: () => Effect.succeed(PROBE_CAPABLE_CONFIG),
        probe: (attempt) => (attempt === 1 ? Effect.sleep("2 seconds") : Effect.void),
        inboundFrames: Ref.get(frames),
        checkHost: () => Ref.update(frames, (count) => count + 1).pipe(Effect.as("answered")),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("5 seconds");

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect((yield* SubscriptionRef.get(supervisor.state)).generation).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each([
    { name: "the host does not answer a fresh request", check: "silent", capable: true },
    {
      name: "an older host answers probes with its full config",
      check: "answered",
      capable: false,
    },
  ] as const)("waits out a LAN resume probe when $name", ({ check, capable }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        initialConfig: () =>
          Effect.succeed(
            capable
              ? PROBE_CAPABLE_CONFIG
              : ({ environment: { capabilities: {} } } as ServerConfig),
          ),
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
        checkHost: () => Effect.succeed(check),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("2999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["application-active-probe", "network-changed"] as const)(
    "gives a live remote socket 15 seconds to answer a %s probe",
    (wakeup) =>
      Effect.gen(function* () {
        // A slow path delays the fresh request as much as the probe.
        const harness = yield* makeSilentSocketHarness({
          probe: (attempt) => (attempt === 1 ? Effect.sleep("4 seconds") : Effect.void),
          checkHost: () => "silent",
        });
        const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        yield* harness.wake(wakeup);
        yield* TestClock.adjust("20 seconds");

        expect(yield* Ref.get(harness.sessionCount)).toBe(1);
        expect((yield* SubscriptionRef.get(supervisor.state)).generation).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces an unanswered long resume probe even while the network reports offline", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-long");
      yield* harness.setNetworkStatus("offline");
      yield* TestClock.adjust("2999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      const reconnected = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(reconnected.lastFailure).toBeNull();
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
