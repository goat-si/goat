import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  type SupervisorConnectionState,
} from "@goat/client-runtime/connection";
import { EnvironmentId, WS_METHODS } from "@goat/contracts";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

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
    const target = new EventTarget();
    const listeners = {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
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

  it.effect("bounds concurrent client activity RPCs across many connected environments", () =>
    Effect.gen(function* () {
      const envIds = Array.from({ length: 10 }, (_, index) => EnvironmentId.make(`env-${index}`));
      const entries = yield* SubscriptionRef.make(
        new Map(envIds.map((id) => [id, { enabled: true }])),
      );
      const release = yield* Deferred.make<void>();
      let inFlight = 0;
      let peakConcurrency = 0;
      let completed = 0;

      const registry = EnvironmentRegistry.EnvironmentRegistry.of({
        entries,
        state: () =>
          Effect.succeed<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected",
          }),
        run: () =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              inFlight += 1;
              if (inFlight > peakConcurrency) peakConcurrency = inFlight;
            }),
            () => Deferred.await(release),
            () =>
              Effect.sync(() => {
                inFlight -= 1;
                completed += 1;
              }),
          ),
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

      yield* Layer.build(
        layer.pipe(Layer.provide(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry))),
      );
      yield* TestClock.adjust("1 second");
      expect(peakConcurrency).toBe(4);
      expect(inFlight).toBe(4);

      yield* Deferred.succeed(release, undefined);
      yield* TestClock.adjust("1 millis");
      expect(completed).toBe(10);
      expect(peakConcurrency).toBe(4);
    }).pipe(Effect.scoped),
  );
});
