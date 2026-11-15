import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderInstallationGate from "./ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import {
  CODEX_DRIVER,
  CODEX_INSTANCE_ID,
  OPENCODE_INSTANCE_ID,
  baseOpenCodeProvider,
  baseProvider,
  layerLatestVersionHttpClient,
  layerMockSpawner,
  layerNonWindowsPlatform,
  makeRegistry,
  makeTestRunner,
} from "./providerMaintenanceRunner.testkit.ts";

it.effect("holds text generation for an instance until its update finishes", () => {
  const updateStarted = Deferred.makeUnsafe<void>();
  const log: Array<string> = [];
  return Effect.gen(function* () {
    const { registry } = yield* makeRegistry(baseProvider, {
      installedVersionAfterUpdate: "1.0.0",
    });
    const updater = yield* makeTestRunner(registry);
    const instance: ProviderInstance = {
      instanceId: CODEX_INSTANCE_ID,
      driverKind: CODEX_DRIVER,
      continuationIdentity: { driverKind: CODEX_DRIVER, continuationKey: CODEX_INSTANCE_ID },
      displayName: undefined,
      enabled: true,
      snapshot: { getSnapshot: Effect.succeed(baseProvider) } as ProviderInstance["snapshot"],
      orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
      textGeneration: TextGeneration.TextGeneration.of({
        generateCommitMessage: () => Effect.die("unused"),
        generatePrContent: () => Effect.die("unused"),
        generateBranchName: () => Effect.die("unused"),
        generateReviewGuide: () => Effect.die("unused"),
        generateThreadTitle: () =>
          Effect.sync(() => {
            log.push("text generation spawned provider");
            return { title: "Generated title" };
          }),
      }),
    };
    const textGeneration = yield* TextGeneration.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            listInstances: Effect.succeed([instance]),
            getInstance: (id) => Effect.succeed(id === CODEX_INSTANCE_ID ? instance : undefined),
          }),
          ServerSettings.layerTest(),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("unused"),
          }),
        ),
      ),
    );

    const update = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
    yield* Deferred.await(updateStarted);
    const generation = yield* textGeneration
      .generateThreadTitle({
        cwd: "/tmp",
        message: "hello",
        linkedContext: "",
        modelSelection: { instanceId: CODEX_INSTANCE_ID, model: "gpt-5" },
      })
      .pipe(Effect.forkScoped);
    yield* TestClock.adjust("1 minute");
    const result = yield* Fiber.join(update);
    yield* Fiber.join(generation);

    assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
    assert.deepStrictEqual(log, ["update command exited", "text generation spawned provider"]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ProviderInstallationGate.layer,
        layerNonWindowsPlatform,
        layerLatestVersionHttpClient("1.0.0"),
        layerMockSpawner(() => ({
          exitCode: Deferred.succeed(updateStarted, undefined).pipe(
            Effect.andThen(Effect.sleep("1 minute")),
            Effect.andThen(Effect.sync(() => log.push("update command exited"))),
            Effect.as(ChildProcessSpawner.ExitCode(0)),
          ),
        })),
      ),
    ),
  );
});

it.effect("holds every instance that shares the updated installation", () => {
  const CODEX_WORK_INSTANCE_ID = ProviderInstanceId.make("codex_work");
  const updateStarted = Deferred.makeUnsafe<void>();
  const log: Array<string> = [];
  return Effect.gen(function* () {
    const { registry } = yield* makeRegistry(
      [baseProvider, { ...baseProvider, instanceId: CODEX_WORK_INSTANCE_ID }, baseOpenCodeProvider],
      { installedVersionAfterUpdate: "1.0.0" },
    );
    // OpenCode installs into the same npm prefix, so it shares the lock key but not the package.
    const updater = yield* makeTestRunner(registry);
    const gate = yield* ProviderInstallationGate.ProviderInstallationGate;

    const update = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
    yield* Deferred.await(updateStarted);
    const shared = yield* gate
      .execute(
        CODEX_WORK_INSTANCE_ID,
        Effect.sync(() => log.push("shared installation ran")),
      )
      .pipe(Effect.forkScoped);
    const other = yield* gate
      .execute(
        OPENCODE_INSTANCE_ID,
        Effect.sync(() => log.push("other driver ran")),
      )
      .pipe(Effect.forkScoped);
    yield* TestClock.adjust("1 minute");
    yield* Fiber.join(update);
    yield* Fiber.join(shared);
    yield* Fiber.join(other);

    assert.deepStrictEqual(log, [
      "other driver ran",
      "update command exited",
      "shared installation ran",
    ]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ProviderInstallationGate.layer,
        layerNonWindowsPlatform,
        layerLatestVersionHttpClient("1.0.0"),
        layerMockSpawner(() => ({
          exitCode: Deferred.succeed(updateStarted, undefined).pipe(
            Effect.andThen(Effect.sleep("1 minute")),
            Effect.andThen(Effect.sync(() => log.push("update command exited"))),
            Effect.as(ChildProcessSpawner.ExitCode(0)),
          ),
        })),
      ),
    ),
  );
});
