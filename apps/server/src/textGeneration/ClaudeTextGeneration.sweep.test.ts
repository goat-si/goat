// @effect-diagnostics-next-line nodeBuiltinImport:off -- Hold the native directory open across the request deadline.
import * as NodeFSP from "node:fs/promises";
import { ProviderInstanceId } from "@goat/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";
import { SYNTHETIC_CLAUDE_STANDARD_MODEL } from "../provider/ClaudeModelCatalog.testFixtures.ts";
import {
  layerClaudeTextGenerationTest,
  withFakeClaudeEnv,
} from "./ClaudeTextGeneration.testkit.ts";

vi.mock("node:fs/promises", { spy: true });

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
});
