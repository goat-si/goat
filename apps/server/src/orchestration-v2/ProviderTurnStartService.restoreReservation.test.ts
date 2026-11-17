import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import { withCheckpointRestoreReservation } from "../workspace/checkpointRestoreReservation.ts";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";

// regression: upstream #12341, a turn start overlapping a checkpoint restore wrote into the checkout.
it.effect.each([
  {
    overlap: "a project-root thread during a restore of a worktree inside the project",
    inner: true,
  },
  { overlap: "a worktree thread during a restore of the folder holding it", inner: false },
])("a turn start in $overlap goes back to retry until the restore ends", ({ inner }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-restore-overlap-" });
    const project = path.join(root, "project");
    const worktreePath = path.join(project, "lane");
    yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
    const harness = makeLocalCommandHarness({
      text: "Continue",
      workspaceRoot: project,
      ...(inner ? {} : { worktreePath, worktreesDir: root }),
      fileSystem,
      failReadsAfterRunning: true,
    });
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const restore = yield* withCheckpointRestoreReservation(
      fileSystem,
      path,
      inner ? worktreePath : project,
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);

    const error = yield* harness.startWithRetry.pipe(Effect.flip);
    expect(error.cause).toBeInstanceOf(ProviderTurnStart.WorkspaceLeaseBusyError);
    expect(harness.open).not.toHaveBeenCalled();

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(restore);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
