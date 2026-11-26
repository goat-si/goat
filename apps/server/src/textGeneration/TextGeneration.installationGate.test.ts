import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import { noMemoryGeneration } from "@goat/provider-core/server/memoryGenerationRunner";
import { TextGenerationError } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

const KNOWN = ProviderInstanceId.make("codex");

// The gate keeps one entry per instance id for the server's lifetime, so only registered ids enter it.
it.effect("takes the installation gate only for a registered provider instance", () =>
  Effect.gen(function* () {
    const gated: Array<string> = [];
    let registered = false;
    const snapshot: ServerProvider = {
      instanceId: KNOWN,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      version: null,
      checkedAt: "2026-11-18T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    };
    const instance = {
      instanceId: KNOWN,
      snapshot: { getSnapshot: Effect.succeed(snapshot) },
      textGeneration: {
        ...noMemoryGeneration,
        generateBranchName: () => Effect.succeed({ branch: "feature/gate" }),
      },
    } as unknown as ProviderInstance;
    const textGeneration = yield* TextGeneration.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: (id) =>
              Effect.sync(() => (registered && id === KNOWN ? instance : undefined)),
            listInstances: Effect.sync(() => (registered ? [instance] : [])),
          }),
          ServerSettings.layerTest(),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("unused"),
          }),
          Layer.succeed(
            ProviderInstallationGate.ProviderInstallationGate,
            ProviderInstallationGate.ProviderInstallationGate.of({
              execute: (instanceId, effect) =>
                Effect.sync(() => gated.push(instanceId)).pipe(Effect.andThen(effect)),
              update: () => Effect.die("unused"),
            }),
          ),
        ),
      ),
    );
    const generate = (instanceId: ProviderInstanceId) =>
      textGeneration.generateBranchName({
        cwd: "/tmp",
        message: "Add a gate",
        modelSelection: { instanceId, model: "gpt-5" },
      });

    const unknown = ProviderInstanceId.make("never-registered");
    assert.equal((yield* Effect.flip(generate(unknown))).detail, "route_unavailable");
    assert.deepEqual(gated, []);

    registered = true;
    assert.deepEqual(yield* generate(KNOWN), { branch: "feature/gate" });
    assert.deepEqual(gated, [KNOWN]);
    assert.deepEqual(yield* generate(unknown), { branch: "feature/gate" });
    assert.deepEqual(gated, [KNOWN, KNOWN]);
  }),
);

it.effect("rechecks a memory summary after waiting for a provider update", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    let paused = false;
    let sent = 0;
    const instance = {
      instanceId: KNOWN,
      textGeneration: {
        ...noMemoryGeneration,
        generateMemorySummary: () =>
          Effect.sync(() => {
            sent += 1;
          }).pipe(Effect.andThen(Effect.die("unused result"))),
      },
    } as unknown as ProviderInstance;
    const textGeneration = yield* TextGeneration.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: () => Effect.succeed(instance),
            listInstances: Effect.succeed([instance]),
          }),
          ServerSettings.layerTest(),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("unused"),
          }),
          Layer.succeed(
            ProviderInstallationGate.ProviderInstallationGate,
            ProviderInstallationGate.ProviderInstallationGate.of({
              execute: (_instanceId, effect) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(released)),
                  Effect.andThen(effect),
                ),
              update: () => Effect.die("unused"),
            }),
          ),
        ),
      ),
    );
    const summary = yield* textGeneration
      .generateMemorySummary({
        modelSelection: { instanceId: KNOWN, model: "gpt-5" },
      } as unknown as TextGeneration.GenerateMemorySummaryInput)
      .pipe(
        Effect.provideService(
          TextGeneration.MemorySummaryDispatchCheck,
          Effect.suspend(() =>
            paused
              ? Effect.fail(
                  new TextGenerationError({
                    operation: "generateMemorySummary",
                    detail: "source_invalidated",
                  }),
                )
              : Effect.void,
          ),
        ),
        Effect.flip,
        Effect.forkChild,
      );
    yield* Deferred.await(entered);
    paused = true;
    yield* Deferred.succeed(released, undefined);
    assert.equal((yield* Fiber.join(summary)).detail, "source_invalidated");
    assert.equal(sent, 0);
  }),
);
