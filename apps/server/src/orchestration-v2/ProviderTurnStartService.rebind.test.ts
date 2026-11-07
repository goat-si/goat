import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { expect } from "vite-plus/test";

import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";

it.effect(
  "a start that loaded the thread before its worktree was replaced retries instead of using the old folder",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const worktreesDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-rebind-" });
      const worktreePath = `${worktreesDir}/project/old`;
      yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
      const harness = makeLocalCommandHarness({
        text: "Continue",
        worktreePath,
        reboundWorktreePath: `${worktreesDir}/project/fresh`,
        worktreesDir,
        fileSystem,
        failReadsAfterRunning: true,
      });
      const error = yield* harness.startWithRetry.pipe(Effect.flip);
      expect(error.cause).toBeInstanceOf(ProviderTurnStart.WorkspaceLeaseBusyError);
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
