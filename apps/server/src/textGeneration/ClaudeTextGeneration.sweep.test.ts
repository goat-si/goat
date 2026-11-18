// @effect-diagnostics-next-line nodeBuiltinImport:off -- Hold the native directory open across the request deadline.
import * as NodeFSP from "node:fs/promises";
import { ClaudeSettings, ProviderInstanceId } from "@goat/contracts";
import type { ProviderDriverCreateInput } from "@goat/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@goat/provider-core/server/maintenanceResolver";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  CLAUDE_PROVIDER,
  ClaudeProviderCapabilitiesV2,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makePendingClaudeProvider } from "../provider/ClaudeProvider.ts";
import { makeProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";
import { SYNTHETIC_CLAUDE_STANDARD_MODEL } from "../provider/ClaudeModelCatalog.testFixtures.ts";
import {
  layerClaudeTextGenerationTest,
  withFakeClaudeEnv,
} from "./ClaudeTextGeneration.testkit.ts";

vi.mock("node:fs/promises", { spy: true });

const decodeClaudeConfig = Schema.decodeSync(ClaudeSettings);

it.layer(layerClaudeTextGenerationTest)("Claude settings cleanup", (it) => {
  it.effect(
    "returns the generation timeout while the private-settings directory open is stalled",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const settings = `${root}/goat-claude-settings-fixture`;
        yield* fs.makeDirectory(settings);
        const { opendir } = yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        );
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        using _open = vi
          .spyOn(NodeFSP, "opendir")
          .mockImplementation(async (directory, options) => {
            if (String(directory) === root) {
              entered.resolve();
              await release.promise;
            }
            return opendir(directory, options);
          });
        yield* withFakeClaudeEnv({ output: "", settingsTempRoot: root }, (generation) =>
          Effect.gen(function* () {
            const running = yield* generation
              .generateThreadTitle({
                cwd: root,
                message: "Synthetic request",
                modelSelection: {
                  instanceId: ProviderInstanceId.make("claudeCode"),
                  model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
                },
              })
              .pipe(Effect.result, Effect.forkChild);
            yield* Effect.promise(() => entered.promise);
            yield* TestClock.adjust("179 seconds");
            expect(running.pollUnsafe()).toBeUndefined();
            yield* TestClock.adjust("1 second");
            const atDeadline = running.pollUnsafe();
            expect(atDeadline?._tag).toBe("Success");
            if (atDeadline !== undefined && Exit.isSuccess(atDeadline)) {
              expect(atDeadline.value._tag).toBe("Failure");
              if (atDeadline.value._tag === "Failure")
                expect(atDeadline.value.failure.detail).toBe("Claude CLI request timed out.");
            }
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                release.resolve();
              }),
            ),
          ),
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            makeTempDirectoryScoped: (options) =>
              options?.prefix?.startsWith("goat-claude-settings-") === true
                ? Effect.succeed(settings)
                : options?.prefix === "goat-claude-title-"
                  ? Effect.succeed(root)
                  : fs.makeTempDirectoryScoped(options),
          }),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.never),
          ),
        );
      }),
  );
  it.effect("replaces the provider while native open is held and closes the late handle", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const { opendir } = yield* Effect.promise(() =>
        vi.importActual<typeof NodeFSP>("node:fs/promises"),
      );
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      let readAfterRetirement = 0;
      using _open = vi.spyOn(NodeFSP, "opendir").mockImplementation(async (directory, options) => {
        if (String(directory) !== root) return opendir(directory, options);
        entered.resolve();
        await release.promise;
        const handle = await opendir(directory, options);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(() =>
          close().then(() => {
            closed.resolve();
          }),
        );
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(() => {
          readAfterRetirement++;
          return read();
        });
        return handle;
      });
      const config = decodeClaudeConfig({ binaryPath: process.execPath });
      const id = ProviderInstanceId.make("claude-replacement");
      const fixtureDriver = {
        driverKind: CLAUDE_PROVIDER,
        metadata: { displayName: "Claude" },
        configSchema: ClaudeSettings,
        defaultConfig: () => config,
        create: Effect.fn("test.createClaude")(function* (
          input: ProviderDriverCreateInput<ClaudeSettings>,
        ) {
          const textGeneration = yield* makeClaudeTextGeneration(input.config);
          const provider = {
            ...(yield* makePendingClaudeProvider(input.config)),
            driver: CLAUDE_PROVIDER,
            instanceId: input.instanceId,
          };
          return {
            instanceId: input.instanceId,
            driverKind: CLAUDE_PROVIDER,
            displayName: input.displayName,
            enabled: input.enabled,
            continuationIdentity: {
              driverKind: CLAUDE_PROVIDER,
              continuationKey: input.instanceId,
            },
            snapshot: {
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: CLAUDE_PROVIDER,
                    packageName: null,
                  }),
                ),
              getSnapshot: Effect.succeed(provider),
              refresh: Effect.succeed(provider),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            orchestrationAdapter: {
              instanceId: input.instanceId,
              driver: CLAUDE_PROVIDER,
              getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
              planSelectionTransition: () => Effect.die("Unexpected selection transition"),
              openSession: () => Effect.die("Unexpected orchestration session"),
            },
            textGeneration,
          };
        }),
      };
      yield* Effect.gen(function* () {
        const entry = { driver: CLAUDE_PROVIDER, enabled: true, config };
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [fixtureDriver],
          configMap: { [id]: entry },
        });
        const original = yield* registry.getInstance(id);
        if (original === undefined) return yield* Effect.die("Missing original Claude instance");
        yield* original.textGeneration
          .generateThreadTitle({
            cwd: root,
            message: "Synthetic request",
            modelSelection: { instanceId: id, model: SYNTHETIC_CLAUDE_STANDARD_MODEL },
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() => entered.promise);
        const replacement = yield* mutator
          .reconcile({ [id]: { ...entry, displayName: "Replacement" } })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("180 seconds");
        const beforeRelease = yield* registry.getInstance(id);
        release.resolve();
        yield* Fiber.join(replacement);
        expect(beforeRelease?.displayName).toBe("Replacement");
        yield* Effect.promise(() => closed.promise);
        expect(readAfterRetirement).toBe(0);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            release.resolve();
          }),
        ),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          makeTempDirectoryScoped: (options) =>
            options?.prefix?.startsWith("goat-claude-settings-") === true
              ? fs.makeTempDirectoryScoped({ ...options, directory: root })
              : fs.makeTempDirectoryScoped(options),
        }),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.never),
        ),
      );
    }),
  );
});
