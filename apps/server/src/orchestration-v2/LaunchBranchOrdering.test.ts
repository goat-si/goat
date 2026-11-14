import { assert, it } from "@effect/vitest";
import { CommandId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import { makeHarness } from "./testkit/ThreadLaunchHarness.ts";
import { launchInput } from "./testkit/threadLaunchInput.ts";

it.effect("starts the agent of a new worktree thread only after its branch is renamed", () =>
  Effect.gen(function* () {
    const branchNameStarted = yield* Deferred.make<void>();
    const allowBranchName = yield* Deferred.make<void>();
    const releasedAtRename = yield* Deferred.make<boolean>();
    let releaseEffects: Effect.Effect<ReadonlyArray<unknown>> = Effect.succeed([]);
    const harness = makeHarness({
      generateBranchName: () =>
        Deferred.succeed(branchNameStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowBranchName)),
          Effect.as({ branch: "generated-branch" }),
        ),
      renameBranch: (input) =>
        Effect.suspend(() => releaseEffects).pipe(
          Effect.flatMap((effects) => Deferred.succeed(releasedAtRename, effects.length > 0)),
          Effect.as({ branch: input.newBranch }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const input = launchInput({
        command: "launch:release-after-rename",
        thread: "thread:release-after-rename",
        message: "Start",
        workspace: { type: "worktree", baseRef: "main" },
      });
      releaseEffects = outbox
        .listByCommandId(CommandId.make(`${input.commandId}:release`))
        .pipe(Effect.orDie);
      const launched = yield* launches.launch(input);
      yield* Deferred.await(branchNameStarted);
      yield* tracker.stream(launched.threadId).pipe(
        Stream.filter(
          (snapshot) =>
            snapshot?.stages.some(
              (stage) => stage.id === "setup-script" && stage.status === "skipped",
            ) === true,
        ),
        Stream.runHead,
      );
      yield* Deferred.succeed(allowBranchName, undefined);
      assert.isFalse(
        yield* Deferred.await(releasedAtRename),
        "the agent's run was released while its branch still had the temporary name",
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);
