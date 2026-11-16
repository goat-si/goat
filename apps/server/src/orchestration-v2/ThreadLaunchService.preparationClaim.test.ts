import { assert, it } from "@effect/vitest";
import { CommandId, GitCommandError } from "@goat/contracts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { makeClaimProbe, makeLaunchHold } from "./goat/PreparationClaims.testkit.ts";
import {
  makeOrphanProbe,
  orphanRun,
  released,
  runStatus,
} from "./goat/PreparationOrphans.testkit.ts";
import { preparationSettled } from "./testkit/preparationSettled.ts";
import { makeHarness, project } from "./testkit/ThreadLaunchHarness.ts";
import { launchInput } from "./testkit/threadLaunchInput.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

it.effect(
  "a launch that replays its accepted first message after a Retry does not prepare the run a second time",
  () =>
    Effect.gen(function* () {
      const claims = yield* makeClaimProbe;
      const retryEntered = yield* Deferred.make<void>();
      const allowRetry = yield* Deferred.make<void>();
      const preparedAgain = yield* Deferred.make<void>();
      let fetches = 0;
      let worktrees = 0;
      const harness = makeHarness({
        claims: claims.layer,
        // The launch's own preparation fails at its fetch; the Retry's gets further.
        fetchWorktreeBaseCommit: () =>
          fetches++ === 0
            ? Effect.fail(
                new GitCommandError({
                  operation: "GitVcsDriver.fetchRemote",
                  command: "git",
                  cwd: project.workspaceRoot,
                  detail: "Git could not reach the remote.",
                  exitCode: 128,
                }),
              )
            : Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
        createWorktree: (request) =>
          (worktrees++ === 0
            ? Deferred.succeed(retryEntered, undefined).pipe(
                Effect.andThen(Deferred.await(allowRetry)),
              )
            : Deferred.succeed(preparedAgain, undefined)
          ).pipe(
            Effect.as({
              worktree: {
                path: "/repo-worktrees/once",
                refName: request.newRefName,
                headSha: "abc",
              },
            } as never),
          ),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const input = launchInput({
          command: "command:replayed-launch",
          thread: "thread:replayed-launch",
          message: "Prepare once",
          workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
        });
        const launched = yield* launches.launch(input);
        const runId = launched.projection.runs[0]!.id;
        assert.equal((yield* preparationSettled(launched.threadId)).runs[0]?.status, "failed");
        yield* launches.retryPreparation({
          commandId: CommandId.make("command:replayed-launch:retry"),
          threadId: launched.threadId,
          runId,
        });
        yield* Deferred.await(retryEntered);

        const replayed = yield* launches.launch(input);
        assert.isTrue(replayed.resumed);
        const outcome = yield* Effect.raceFirst(
          claims.refused.pipe(Effect.as("left to the Retry")),
          Deferred.await(preparedAgain).pipe(Effect.as("prepared again")),
        );
        assert.equal(outcome, "left to the Retry");

        yield* Deferred.succeed(allowRetry, undefined);
        yield* released(launched.threadId, "command:replayed-launch:retry");
        assert.equal(worktrees, 1);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect.each(["the orphan check", "a fail command"] as const)(
  "a run failed by %s while a launch was about to prepare it is not then prepared by that launch",
  (failer) =>
    Effect.gen(function* () {
      const probe = yield* makeOrphanProbe;
      const hold = yield* makeLaunchHold;
      const harness = makeHarness({ launchThreads: hold.wrap });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const { input, threadId, runId } = yield* orphanRun("late-launch");
        yield* hold.arm;
        // A launch resumed for the run: held after its read finds it preparing.
        const launch = yield* launches
          .launch(input)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* hold.held;
        if (failer === "a fail command") {
          yield* threads.dispatch({
            type: "prepared-run.fail",
            commandId: CommandId.make("command:late-launch:fail"),
            threadId,
            runId,
            failure: makeProviderFailure({ message: "Preparation was stopped." }),
          });
        } else {
          for (let pass = 1; pass <= 4; pass++) assert.equal(yield* probe.pass, "read");
          assert.equal(yield* probe.failed, runId);
        }
        assert.equal(yield* runStatus(threadId, runId), "failed");

        yield* hold.resume;
        yield* Fiber.join(launch);
        assert.equal(yield* hold.next, "read again");
        assert.deepEqual(yield* hold.releases, []);
        assert.equal(yield* runStatus(threadId, runId), "failed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(harness.layer, probe.layer.pipe(Layer.provide(harness.layer))),
        ),
      );
    }),
);
