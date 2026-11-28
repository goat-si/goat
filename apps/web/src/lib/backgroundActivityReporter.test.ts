import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  type SupervisorConnectionState,
} from "@goat/client-runtime/connection";
import { type ClientActivityReportInput, EnvironmentId, WS_METHODS } from "@goat/contracts";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

const capturedRequests = vi.hoisted(
  () => [] as Array<{ readonly method: string; readonly input: unknown }>,
);
vi.mock(import("@goat/client-runtime/rpc"), async (original) => {
  const actual = await original();
  const wrappedRequest = (...args: Parameters<typeof actual.request>) => {
    capturedRequests.push({ method: args[0], input: args[1] });
    return actual.request(...args);
  };
  return {
    ...actual,
    request: wrappedRequest as typeof actual.request,
  };
});

import {
  layer,
  observeBackgroundActivitySubscription,
  retainedBackgroundScopes,
} from "./backgroundActivityReporter.ts";

describe("wasRecentlyInteracted", () => {
  it.effect("retains an observed subscription until its returned finalizer runs", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-observation-test");
      const scope = { type: "vcs-status" as const, cwd: "/repo" };
      const releasePassive = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: scope.cwd, includeRemote: false },
      });
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
      const release = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: scope.cwd },
      });

      expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

      yield* releasePassive;
      expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

      yield* release;
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("keeps delimiter-containing environment and scope values distinct", () =>
    Effect.gen(function* () {
      const firstEnvironmentId = EnvironmentId.make("a");
      const secondEnvironmentId = EnvironmentId.make("a:vcs-status:b");
      const releaseFirst = yield* observeBackgroundActivitySubscription({
        environmentId: firstEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "b:vcs-status:c" },
      });
      const releaseSecond = yield* observeBackgroundActivitySubscription({
        environmentId: secondEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "c" },
      });

      expect(retainedBackgroundScopes(firstEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "b:vcs-status:c" },
      ]);
      expect(retainedBackgroundScopes(secondEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "c" },
      ]);

      yield* Effect.all([releaseFirst, releaseSecond]);
    }),
  );
});

describe("layer", () => {
  beforeEach(() => {
    capturedRequests.length = 0;
    const target = new EventTarget();
    const listeners = {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    };
    vi.stubGlobal("window", {
      ...listeners,
      localStorage: { getItem: () => "client", setItem: () => undefined },
    });
    vi.stubGlobal("document", { ...listeners, visibilityState: "visible", hasFocus: () => true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // As when an environment's connection is torn down while its report is in flight.
  it.effect("keeps reporting after a report is interrupted", () =>
    Effect.gen(function* () {
      const envId = EnvironmentId.make("environment-reporter-test");
      const entries = yield* SubscriptionRef.make(new Map([[envId, { enabled: true }]]));
      let calls = 0;
      const registry = EnvironmentRegistry.EnvironmentRegistry.of({
        entries,
        state: () =>
          Effect.succeed<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected",
          }),
        run: () => {
          calls += 1;
          return calls === 1 ? Effect.failCause(Cause.interrupt()) : Effect.void;
        },
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

      yield* Layer.build(
        layer.pipe(Layer.provide(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry))),
      );
      yield* TestClock.adjust("1 second");
      expect(calls).toBe(1);

      yield* TestClock.adjust("25 seconds");
      expect(calls).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps reporting after a report never settles", () =>
    Effect.gen(function* () {
      const envId = EnvironmentId.make("environment-reporter-test");
      const entries = yield* SubscriptionRef.make(new Map([[envId, { enabled: true }]]));
      let calls = 0;
      const registry = EnvironmentRegistry.EnvironmentRegistry.of({
        entries,
        state: () =>
          Effect.succeed<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected",
          }),
        run: () => {
          calls += 1;
          return calls === 1 ? Effect.never : Effect.void;
        },
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

      yield* Layer.build(
        layer.pipe(Layer.provide(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry))),
      );
      yield* TestClock.adjust("1 second");
      expect(calls).toBe(1);

      yield* TestClock.adjust("25 seconds");
      expect(calls).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "reports only to enabled connected environments and skips disconnected supervisors",
    () =>
      Effect.gen(function* () {
        const connectedId = EnvironmentId.make("env-connected");
        const offlineId = EnvironmentId.make("env-offline");
        const backoffId = EnvironmentId.make("env-backoff");
        const disabledId = EnvironmentId.make("env-disabled");
        const entries = yield* SubscriptionRef.make(
          new Map([
            [connectedId, { enabled: true }],
            [offlineId, { enabled: true }],
            [backoffId, { enabled: true }],
            [disabledId, { enabled: false }],
          ]),
        );
        const phases = new Map<EnvironmentId, SupervisorConnectionState["phase"]>([
          [connectedId, "connected"],
          [offlineId, "offline"],
          [backoffId, "backoff"],
          [disabledId, "connected"],
        ]);
        const reported: EnvironmentId[] = [];
        const stateQueried: EnvironmentId[] = [];
        const registry = EnvironmentRegistry.EnvironmentRegistry.of({
          entries,
          state: (environmentId: EnvironmentId) =>
            Effect.sync(() => {
              stateQueried.push(environmentId);
              return {
                ...AVAILABLE_CONNECTION_STATE,
                phase: phases.get(environmentId) ?? "offline",
              };
            }),
          run: (environmentId: EnvironmentId) =>
            Effect.sync(() => {
              reported.push(environmentId);
            }),
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

        yield* Layer.build(
          layer.pipe(
            Layer.provide(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry)),
          ),
        );
        yield* TestClock.adjust("1 second");

        expect(reported).toEqual([connectedId]);
        expect(stateQueried).not.toContain(disabledId);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps at most one in-flight report per environment across overlapping triggers", () =>
    Effect.gen(function* () {
      const envIds = [EnvironmentId.make("env-0"), EnvironmentId.make("env-1")];
      const entries = yield* SubscriptionRef.make(
        new Map(envIds.map((id) => [id, { enabled: true }])),
      );
      const release = yield* Deferred.make<void>();
      const inFlightByEnv = new Map<EnvironmentId, number>();
      const peakByEnv = new Map<EnvironmentId, number>();
      const callsByEnv = new Map<EnvironmentId, number>();

      const registry = EnvironmentRegistry.EnvironmentRegistry.of({
        entries,
        state: () =>
          Effect.succeed<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected",
          }),
        run: (environmentId: EnvironmentId) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              callsByEnv.set(environmentId, (callsByEnv.get(environmentId) ?? 0) + 1);
              const next = (inFlightByEnv.get(environmentId) ?? 0) + 1;
              inFlightByEnv.set(environmentId, next);
              if (next > (peakByEnv.get(environmentId) ?? 0)) {
                peakByEnv.set(environmentId, next);
              }
            }),
            () => Deferred.await(release),
            () =>
              Effect.sync(() => {
                inFlightByEnv.set(environmentId, (inFlightByEnv.get(environmentId) ?? 1) - 1);
              }),
          ),
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

      yield* Layer.build(
        layer.pipe(Layer.provide(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry))),
      );

      yield* TestClock.adjust("1 second");
      // Trigger another report pass while the first attempt is still in flight.
      window.dispatchEvent(new Event("focus"));
      yield* TestClock.adjust("1 second");

      for (const envId of envIds) {
        expect(peakByEnv.get(envId)).toBe(1);
        expect(callsByEnv.get(envId)).toBe(1);
      }

      yield* Deferred.succeed(release, undefined);
      yield* TestClock.adjust("1 millis");
      // The focus trigger queued during the in-flight attempt fires one follow-up immediately.
      for (const envId of envIds) {
        expect(callsByEnv.get(envId)).toBe(2);
        expect(peakByEnv.get(envId)).toBe(1);
      }

      // Next scheduled periodic pass runs after the interval.
      yield* TestClock.adjust("25 seconds");
      for (const envId of envIds) {
        expect(callsByEnv.get(envId)).toBe(3);
        expect(peakByEnv.get(envId)).toBe(1);
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "runs a follow-up report with updated focus and scopes when activity changes while a report is in flight",
    () =>
      Effect.gen(function* () {
        let focused = false;
        const target = new EventTarget();
        const listeners = {
          addEventListener: target.addEventListener.bind(target),
          removeEventListener: target.removeEventListener.bind(target),
          dispatchEvent: target.dispatchEvent.bind(target),
        };
        vi.stubGlobal("window", {
          ...listeners,
          localStorage: { getItem: () => "client", setItem: () => undefined },
        });
        vi.stubGlobal("document", {
          ...listeners,
          visibilityState: "visible",
          hasFocus: () => focused,
        });

        const envId = EnvironmentId.make("env-followup");
        const entries = yield* SubscriptionRef.make(new Map([[envId, { enabled: true }]]));
        const releaseFirst = yield* Deferred.make<void>();
        let callCount = 0;

        const registry = EnvironmentRegistry.EnvironmentRegistry.of({
          entries,
          state: () =>
            Effect.succeed<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "connected",
            }),
          run: () => {
            callCount += 1;
            return callCount === 1 ? Deferred.await(releaseFirst) : Effect.void;
          },
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

        yield* Layer.build(
          layer.pipe(
            Layer.provide(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry)),
          ),
        );

        // Initial report starts with focused=false and only baseline scope.
        yield* TestClock.adjust("1 second");
        expect(callCount).toBe(1);
        expect(capturedRequests).toHaveLength(1);
        expect(capturedRequests[0]?.input).toMatchObject<Partial<ClientActivityReportInput>>({
          environmentId: envId,
          focused: false,
          scopes: [{ type: "provider-status" }],
        });

        // While the first report is still in flight, window gains focus and a vcs-status scope is retained.
        focused = true;
        const releaseScope = yield* observeBackgroundActivitySubscription({
          environmentId: envId,
          method: WS_METHODS.subscribeVcsStatus,
          input: { cwd: "/repo/live" },
        });
        window.dispatchEvent(new Event("focus"));
        yield* TestClock.adjust("500 millis");
        // Still only 1 concurrent in-flight call.
        expect(callCount).toBe(1);

        // Once the first attempt settles, one follow-up fires immediately with the updated payload.
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* TestClock.adjust("1 millis");
        expect(callCount).toBe(2);
        expect(capturedRequests).toHaveLength(2);
        expect(capturedRequests[1]?.input).toMatchObject<Partial<ClientActivityReportInput>>({
          environmentId: envId,
          focused: true,
          scopes: [{ type: "provider-status" }, { type: "vcs-status", cwd: "/repo/live" }],
        });

        yield* releaseScope;
      }).pipe(Effect.scoped),
  );

  it.effect(
    "triggers a report promptly when an enabled environment transitions into connected and cleans up watchers on removal",
    () =>
      Effect.gen(function* () {
        const envId = EnvironmentId.make("env-connecting");
        const entries = yield* SubscriptionRef.make(new Map([[envId, { enabled: true }]]));
        const connState = yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connecting",
        });
        let reportCount = 0;
        let activeWatchers = 0;

        const registry = EnvironmentRegistry.EnvironmentRegistry.of({
          entries,
          state: () => SubscriptionRef.get(connState),
          stateChanges: () =>
            Stream.unwrap(
              Effect.acquireRelease(
                Effect.sync(() => {
                  activeWatchers += 1;
                }),
                () =>
                  Effect.sync(() => {
                    activeWatchers -= 1;
                  }),
              ).pipe(Effect.as(SubscriptionRef.changes(connState))),
            ),
          run: () =>
            Effect.sync(() => {
              reportCount += 1;
            }),
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

        yield* Layer.build(
          layer.pipe(
            Layer.provide(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry)),
          ),
        );

        // Connecting environment does not report on startup.
        yield* TestClock.adjust("1 second");
        expect(reportCount).toBe(0);
        expect(activeWatchers).toBe(1);

        // Transitioning into connected reports promptly without waiting for the 25s timer.
        yield* SubscriptionRef.set(connState, {
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected" as const,
        });
        yield* TestClock.adjust("1 millis");
        expect(reportCount).toBe(1);

        // Removing the environment interrupts its stateChanges watcher cleanly.
        yield* SubscriptionRef.set(entries, new Map());
        yield* TestClock.adjust("1 millis");
        expect(activeWatchers).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "does not let 40 stalled environments delay healthy lease renewals or issue duplicate concurrent retries",
    () =>
      Effect.gen(function* () {
        const stalledIds = Array.from({ length: 40 }, (_, index) =>
          EnvironmentId.make(`stalled-${index}`),
        );
        const healthyId = EnvironmentId.make("healthy-0");
        const allIds = [...stalledIds, healthyId];
        const stalledSet = new Set<EnvironmentId>(stalledIds);
        const entries = yield* SubscriptionRef.make(
          new Map(allIds.map((id) => [id, { enabled: true }])),
        );
        const healthyReportTimes: number[] = [];
        const stalledInFlight = new Map<EnvironmentId, number>();
        let maxStalledConcurrentPerEnv = 0;

        const registry = EnvironmentRegistry.EnvironmentRegistry.of({
          entries,
          state: () =>
            Effect.succeed<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "connected",
            }),
          run: (environmentId: EnvironmentId) =>
            stalledSet.has(environmentId)
              ? Effect.acquireUseRelease(
                  Effect.sync(() => {
                    const next = (stalledInFlight.get(environmentId) ?? 0) + 1;
                    stalledInFlight.set(environmentId, next);
                    if (next > maxStalledConcurrentPerEnv) maxStalledConcurrentPerEnv = next;
                  }),
                  () => Effect.never,
                  () =>
                    Effect.sync(() => {
                      stalledInFlight.set(
                        environmentId,
                        (stalledInFlight.get(environmentId) ?? 1) - 1,
                      );
                    }),
                )
              : Clock.currentTimeMillis.pipe(
                  Effect.tap((now) =>
                    Effect.sync(() => {
                      healthyReportTimes.push(now);
                    }),
                  ),
                  Effect.asVoid,
                ),
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

        yield* Layer.build(
          layer.pipe(
            Layer.provide(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry)),
          ),
        );

        // First pass must report to the healthy peer immediately without waiting on 40 stalled peers.
        yield* TestClock.adjust("1 second");
        expect(healthyReportTimes).toHaveLength(1);

        // Trigger an overlapping focus event mid-timeout: stalled peers must not get duplicate calls.
        window.dispatchEvent(new Event("focus"));
        yield* TestClock.adjust("1 second");
        expect(maxStalledConcurrentPerEnv).toBe(1);

        // Advance across 3 reporting cycles while all 40 stalled peers hang indefinitely.
        yield* TestClock.adjust("25 seconds");
        yield* TestClock.adjust("25 seconds");
        yield* TestClock.adjust("25 seconds");

        expect(maxStalledConcurrentPerEnv).toBe(1);
        expect(healthyReportTimes.length).toBeGreaterThanOrEqual(4);
        for (let index = 1; index < healthyReportTimes.length; index++) {
          const gap = healthyReportTimes[index]! - healthyReportTimes[index - 1]!;
          expect(gap).toBeLessThan(45_000);
        }
      }).pipe(Effect.scoped),
  );
});
