import { vi } from "vite-plus/test";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Sessions from "../auth/SessionStore.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { session } from "./CodexRouteService.testkit.ts";
import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderDriverKind, ProviderInstanceId, TurnItemId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Routes from "./CodexRouteService.ts";
import * as Settings from "../serverSettings.ts";
import * as Config from "../config.ts";
import {
  caller,
  commitAndApply,
  environmentId,
  instanceId,
  layer,
} from "./CodexRouteService.testkit.ts";
const decode = Schema.decodeSync(CodexSettings);
const base = {
  driver: ProviderDriverKind.make("codex"),
  displayName: "Original name",
  config: decode({ homePath: "/test/shared-home" }),
};
const seed = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  yield* settings.start;
  const routes = yield* Routes.CodexRouteService;
  yield* commitAndApply(
    routes.mutateProviderInstance(
      { mutation: { operation: "create", instanceId, instance: base } },
      caller,
    ),
  );
  return routes;
});
it.effect("rejects route changes with provider_instance_busy while a Codex session is active", () =>
  Effect.gen(function* () {
    const routes = yield* seed;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Config.ServerConfig;
    const before = yield* fs.readFileString(config.settingsPath);
    const scope = yield* Scope.make();
    yield* routes.reserveUse(instanceId).pipe(Effect.provideService(Scope.Scope, scope));
    const result = yield* routes
      .mutateProviderInstance(
        {
          mutation: {
            operation: "upsert",
            instanceId,
            instance: { ...base, config: { ...base.config, modelRoute: "opencodex" } },
          },
        },
        caller,
      )
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "provider_instance_busy");
      assert.equal(
        result.failure.message,
        "Wait for this instance's active turns to finish before changing its model route.",
      );
    }
    assert.equal(yield* fs.readFileString(config.settingsPath), before);
    yield* Scope.close(scope, Exit.void);
    const saved = yield* commitAndApply(
      routes.mutateProviderInstance(
        {
          mutation: {
            operation: "upsert",
            instanceId,
            instance: {
              ...base,
              displayName: "Home with the same home",
              config: { ...base.config, modelRoute: "opencodex" },
            },
          },
        },
        caller,
      ),
    );
    assert.equal(saved.providerInstances[instanceId]?.displayName, "Home with the same home");
  }).pipe(Effect.provide(layer)),
);
it.effect(
  "checks the private approval precondition under the settings lock before no-op and secret writes",
  () =>
    Effect.gen(function* () {
      const routes = yield* seed;
      const approved = yield* routes.capture(instanceId);
      const expected = {
        handoffId: TurnItemId.make("approval-a"),
        environmentId,
        instanceId,
        expectedFingerprint: approved.fingerprint,
        expectedRevision: approved.revision,
      };
      yield* commitAndApply(
        routes.mutateProviderInstance(
          {
            mutation: {
              operation: "upsert",
              instanceId,
              instance: { ...base, displayName: "Competing UI B" },
            },
          },
          caller,
        ),
      );
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      const before = yield* fs.readFileString(config.settingsPath);
      const result = yield* routes
        .mutateProviderInstance(
          {
            mutation: {
              operation: "upsert",
              instanceId,
              instance: { ...base, config: { ...base.config, modelRoute: "opencodex" } },
            },
          },
          caller,
          expected,
        )
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.equal(result.failure.message, "This approval is stale. Ask again.");
      assert.equal((yield* routes.capture(instanceId)).instance.displayName, "Competing UI B");
      assert.equal(yield* fs.readFileString(config.settingsPath), before);
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "atomically creates a Home preset with all submitted fields and patch and waits for its exact hydration revision",
  () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const routes = yield* Routes.CodexRouteService;
      const state = yield* Routes.CodexRouteState;
      yield* settings.start;
      const changes = (yield* settings.subscribeProviderChanges!).pipe(
        Stream.filter((event) => event.revision.sequence > 0),
      );
      const finished = yield* Deferred.make<void>();
      const write = yield* routes
        .mutateProviderInstance(
          {
            mutation: {
              operation: "create",
              instanceId,
              instance: {
                ...base,
                environment: [{ name: "HOME_ROUTE_TEST", value: "kept", sensitive: false }],
                config: { ...base.config, modelRoute: "opencodex" },
              },
            },
            patch: { worktreesDirectory: "/atomic-worktrees" },
          },
          caller,
        )
        .pipe(
          Effect.tap(() => Deferred.succeed(finished, undefined)),
          Effect.forkScoped,
        );
      const event = yield* Stream.runHead(changes);
      assert.isTrue(Option.isSome(event));
      assert.isFalse(yield* Deferred.isDone(finished));
      yield* Effect.scoped(routes.reserveUse(ProviderInstanceId.make("unrelated-instance")));
      assert.equal(
        (yield* Effect.scoped(routes.reserveUse(instanceId)).pipe(Effect.result))._tag,
        "Failure",
      );
      if (Option.isNone(event)) return;
      assert.equal(event.value.settings.worktreesDirectory, "/atomic-worktrees");
      assert.equal(
        event.value.settings.providerInstances[instanceId]?.environment?.[0]?.value,
        "kept",
      );
      yield* state.applied({
        ...event.value.revision,
        sequence: event.value.revision.sequence + 1,
      });
      assert.isFalse(yield* Deferred.isDone(finished));
      yield* state.applied(event.value.revision);
      const saved = yield* Fiber.join(write);
      assert.equal(saved.providerInstances[instanceId]?.displayName, base.displayName);
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "does not acknowledge a no-op after hydration timeout and retries an identical committed create",
  () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const state = yield* Routes.CodexRouteState;
      const routes = yield* Routes.CodexRouteService;
      yield* settings.start;
      const changes = (yield* settings.subscribeProviderChanges!).pipe(
        Stream.filter((event) => event.revision.sequence > 0),
      );
      const create = routes.mutateProviderInstance(
        { mutation: { operation: "create", instanceId, instance: base } },
        caller,
      );
      const writer = yield* create.pipe(Effect.result, Effect.forkScoped);
      const event = yield* Stream.runHead(changes);
      assert.isTrue(Option.isSome(event));
      yield* TestClock.adjust("31 seconds");
      assert.equal((yield* Fiber.join(writer))._tag, "Failure");
      assert.equal(
        (yield* Effect.scoped(routes.reserveUse(instanceId)).pipe(Effect.result))._tag,
        "Failure",
      );
      if (Option.isNone(event)) return;
      const retryWaiting = yield* Deferred.make<
        void,
        import("@goat/contracts").ServerSettingsError
      >();
      const retryFinished = yield* Deferred.make<void>();
      const awaitApplied = state.awaitApplied;
      const observedWait = vi
        .spyOn(state, "awaitApplied")
        .mockImplementation((ids) =>
          Deferred.succeed(retryWaiting, undefined).pipe(Effect.andThen(awaitApplied(ids))),
        );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          observedWait.mockRestore();
        }),
      );
      const retry = yield* create.pipe(
        Effect.tapError((error) => Deferred.fail(retryWaiting, error)),
        Effect.tap(() => Deferred.succeed(retryFinished, undefined)),
        Effect.forkScoped,
      );
      yield* Deferred.await(retryWaiting);
      assert.isFalse(yield* Deferred.isDone(retryFinished));
      assert.deepStrictEqual(state.revision(), event.value.revision);
      yield* state.applied({
        ...event.value.revision,
        sequence: event.value.revision.sequence + 1,
      });
      assert.isFalse(yield* Deferred.isDone(retryFinished));
      yield* state.applied(event.value.revision);
      assert.equal(
        (yield* Fiber.join(retry)).providerInstances[instanceId]?.displayName,
        base.displayName,
      );
      assert.deepStrictEqual(state.revision(), event.value.revision);
      observedWait.mockRestore();
      const alreadyApplied = yield* create;
      assert.equal(alreadyApplied.providerInstances[instanceId]?.displayName, base.displayName);
      assert.deepStrictEqual(state.revision(), event.value.revision);
    }).pipe(Effect.provide(layer)),
);

it.effect("rechecks expiry and client permissions at commit before writing settings", () =>
  Effect.gen(function* () {
    const routes = yield* seed;
    const approved = yield* routes.capture(instanceId);
    const expired = yield* routes
      .mutateProviderInstance(
        {
          mutation: {
            operation: "upsert",
            instanceId,
            instance: { ...base, displayName: "Expired request" },
          },
        },
        caller,
        {
          handoffId: TurnItemId.make("expired-approval"),
          environmentId,
          instanceId,
          expectedFingerprint: approved.fingerprint,
          expectedRevision: approved.revision,
          expiresAt: DateTime.toEpochMillis(yield* DateTime.now),
        },
      )
      .pipe(Effect.result);
    assert.equal(expired._tag, "Failure");
    let checks = 0;
    const checkingCommit = yield* Deferred.make<void>();
    const resumeCommitCheck = yield* Deferred.make<void>();
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Config.ServerConfig;
    const before = yield* fs.readFileString(config.settingsPath);
    const restricted = Context.get(
      yield* Layer.build(
        Layer.fresh(Routes.layer).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Sessions.SessionStore)({
                cookieName: "test",
                legacyCookieName: undefined,
                listActive: () =>
                  Effect.gen(function* () {
                    checks++;
                    if (checks === 1) return [session(yield* DateTime.now)];
                    yield* Deferred.succeed(checkingCommit, undefined);
                    yield* Deferred.await(resumeCommitCheck);
                    return [];
                  }),
              }),
              Layer.succeed(Environment.ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(environmentId),
              }),
            ),
          ),
        ),
      ),
      Routes.CodexRouteService,
    );
    assert.notStrictEqual(restricted, routes);
    const denial = yield* restricted
      .mutateProviderInstance(
        {
          mutation: {
            operation: "upsert",
            instanceId,
            instance: { ...base, displayName: "Revoked request" },
          },
        },
        caller,
      )
      .pipe(Effect.result, Effect.forkScoped);
    yield* Deferred.await(checkingCommit);
    assert.equal(checks, 2);
    assert.equal(yield* fs.readFileString(config.settingsPath), before);
    yield* Deferred.succeed(resumeCommitCheck, undefined);
    const denied = yield* Fiber.join(denial);
    assert.equal(denied._tag, "Failure");
    assert.equal(yield* fs.readFileString(config.settingsPath), before);
    assert.deepStrictEqual((yield* routes.capture(instanceId)).revision, approved.revision);
    assert.equal((yield* routes.capture(instanceId)).instance.displayName, base.displayName);
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects a conflicting create instead of replacing a canonical committed instance", () =>
  Effect.gen(function* () {
    const routes = yield* seed;
    const before = yield* routes.capture(instanceId);
    const conflict = yield* routes
      .mutateProviderInstance(
        {
          mutation: {
            operation: "create",
            instanceId,
            instance: { ...base, displayName: "Different create" },
          },
        },
        caller,
      )
      .pipe(Effect.result);
    assert.equal(conflict._tag, "Failure");
    if (conflict._tag === "Failure")
      assert.equal(conflict.failure.operation, "create-provider-instance");
    assert.deepStrictEqual(yield* routes.capture(instanceId), before);
  }).pipe(Effect.provide(layer)),
);
