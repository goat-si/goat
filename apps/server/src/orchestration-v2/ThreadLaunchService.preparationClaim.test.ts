import { assert, it } from "@effect/vitest";
import { CommandId, GitCommandError } from "@goat/contracts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeClaimProbe, makeLaunchHold } from "./goat/PreparationClaims.testkit.ts";
import { orphanRun, released, runStatus } from "./goat/PreparationOrphans.testkit.ts";
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

        // Returns once the replay's preparation is in line behind the Retry's.
        const replayed = yield* launches.launch(input);
        assert.isTrue(replayed.resumed);
        const outcome = yield* Effect.raceFirst(
          Deferred.await(preparedAgain).pipe(Effect.as("prepared again")),
          Effect.gen(function* () {
            yield* Deferred.succeed(allowRetry, undefined);
            // The launch's own preparation, the Retry's, then the replay's, which finds the run
            // no longer preparing.
            for (let ended = 1; ended <= 3; ended++) yield* claims.outcome;
            return "prepared once" as const;
          }),
        );
        assert.equal(outcome, "prepared once");
        yield* released(launched.threadId, "command:replayed-launch:retry");
        assert.equal(worktrees, 1);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect(
  "a run failed while a launch was about to prepare it is not then prepared by that launch",
  () =>
    Effect.gen(function* () {
      const hold = yield* makeLaunchHold;
      const harness = makeHarness({ launchThreads: hold.wrap });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const { input, threadId, runId } = yield* orphanRun("late-launch");
        yield* hold.arm;
        // A launch resumed for the run (root strategy): held after its read finds it preparing.
        const launch = yield* launches
          .launch(input)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* hold.held;
        yield* threads.dispatch({
          type: "prepared-run.fail",
          commandId: CommandId.make("command:late-launch:fail"),
          threadId,
          runId,
          failure: makeProviderFailure({ message: "Preparation was stopped." }),
        });
        assert.equal(yield* runStatus(threadId, runId), "failed");

        yield* hold.resume;
        yield* Fiber.join(launch);
        assert.equal(yield* hold.next, "read again");
        assert.deepEqual(yield* hold.releases, []);
        assert.equal(yield* runStatus(threadId, runId), "failed");
      }).pipe(Effect.provide(harness.layer));
    }),
);
