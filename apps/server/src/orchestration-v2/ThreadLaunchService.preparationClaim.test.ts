import { assert, it } from "@effect/vitest";
import { CommandId, GitCommandError } from "@goat/contracts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { makeClaimProbe, makeLaunchHold } from "./goat/PreparationClaims.testkit.ts";
import { orphanRun, released, runStatus } from "./goat/PreparationOrphans.testkit.ts";
import { STRETCH_CHANGED, refusalReason } from "./goat/PreparationStretch.ts";
import { preparationSettled } from "./testkit/preparationSettled.ts";
import { makeHarness, project } from "./testkit/ThreadLaunchHarness.ts";
import { launchInput } from "./testkit/threadLaunchInput.ts";
import { OrchestratorProjectionError } from "./Orchestrator.ts";
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

it.effect(
  "a replay whose scheduling fails while another preparation holds the run leaves the run to that preparation",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const allow = yield* Deferred.make<void>();
      const failMessages = yield* Ref.make(false);
      const harness = makeHarness({
        createWorktree: (request) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(allow)),
            Effect.as({
              worktree: {
                path: "/repo-worktrees/held",
                refName: request.newRefName,
                headSha: "abc",
              },
            } as never),
          ),
        // The replay's read of the run's message fails, so its scheduling fails.
        launchThreads: (threads) => ({
          ...threads,
          getThreadRecords: (threadId, fields, filter) =>
            Ref.get(failMessages).pipe(
              Effect.flatMap((failing) =>
                failing && (fields as ReadonlyArray<string>).includes("messages")
                  ? Effect.fail(new OrchestratorProjectionError({ threadId, cause: "unreadable" }))
                  : threads.getThreadRecords(threadId, fields, filter),
              ),
            ),
        }),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const launched = yield* launches.launch(
          launchInput({
            command: "command:held-preparation",
            thread: "thread:held-preparation",
            message: "Prepare once",
            workspace: { type: "worktree", baseRef: "main" },
          }),
        );
        const runId = launched.projection.runs[0]!.id;
        yield* Deferred.await(entered);

        // A replayed delegation reaches prepareRun with its own command id.
        yield* Ref.set(failMessages, true);
        yield* launches.prepareRun({
          commandId: CommandId.make("command:held-preparation:replay"),
          threadId: launched.threadId,
          runId,
        });
        assert.equal(yield* runStatus(launched.threadId, runId), "preparing");

        yield* Ref.set(failMessages, false);
        yield* Deferred.succeed(allow, undefined);
        yield* released(launched.threadId, "command:held-preparation");
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect(
  "a replayed preparation whose scheduling fails after the run was failed and retried leaves the Retry's stretch to the Retry",
  () =>
    Effect.gen(function* () {
      const claims = yield* makeClaimProbe;
      const entered = yield* Deferred.make<void>();
      const failFirst = yield* Deferred.make<void>();
      const armed = yield* Ref.make(false);
      const readHeld = yield* Deferred.make<void>();
      const failRead = yield* Deferred.make<void>();
      const replayFail = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
      let worktrees = 0;
      const harness = makeHarness({
        claims: claims.layer,
        createWorktree: (request) =>
          worktrees++ === 0
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(failFirst)),
                Effect.andThen(
                  Effect.fail(
                    new GitCommandError({
                      operation: "GitVcsDriver.createWorktree",
                      command: "git worktree add",
                      cwd: project.workspaceRoot,
                      detail: "The branch is checked out elsewhere.",
                    }),
                  ),
                ),
              )
            : Effect.succeed({
                worktree: {
                  path: "/repo-worktrees/x",
                  refName: request.newRefName,
                  headSha: "abc",
                },
              } as never),
        launchThreads: (threads) => ({
          ...threads,
          // The replay's read of the run's message is held, then fails, so its scheduling fails.
          getThreadRecords: (threadId, fields, filter) =>
            Effect.gen(function* () {
              if (
                !(fields as ReadonlyArray<string>).includes("messages") ||
                !(yield* Ref.getAndSet(armed, false))
              )
                return yield* threads.getThreadRecords(threadId, fields, filter);
              yield* Deferred.succeed(readHeld, undefined);
              yield* Deferred.await(failRead);
              return yield* new OrchestratorProjectionError({ threadId, cause: "unreadable" });
            }),
          dispatch: (command) =>
            command.commandId === CommandId.make("command:replay-a:fail")
              ? threads
                  .dispatch(command)
                  .pipe(Effect.onExit((exit) => Deferred.succeed(replayFail, exit)))
              : threads.dispatch(command),
        }),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        // B: the launch's own preparation, holding the claim on its worktree step.
        const launched = yield* launches.launch(
          launchInput({
            command: "command:replay-b",
            thread: "thread:replay-stretch",
            message: "Prepare the right stretch",
            workspace: { type: "worktree", baseRef: "main" },
          }),
        );
        const { threadId } = launched;
        const runId = launched.projection.runs[0]!.id;
        yield* Deferred.await(entered);

        // A: a replayed delegation reaches prepareRun with its own command id and finds stretch k.
        yield* Ref.set(armed, true);
        const replay = yield* launches
          .prepareRun({ commandId: CommandId.make("command:replay-a"), threadId, runId })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(readHeld);

        // B fails stretch k and lets go of the claim.
        yield* Deferred.succeed(failFirst, undefined);
        assert.deepEqual(yield* claims.outcome, { runId, ran: true });
        assert.equal(yield* runStatus(threadId, runId), "failed");

        // X: a Retry starts stretch k+1 and holds only its mark, short of the claim line.
        const atLine = yield* claims.holdNextAtLine;
        const retry = yield* launches
          .retryPreparation({ commandId: CommandId.make("command:replay-x"), threadId, runId })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* atLine.held;
        assert.equal(yield* runStatus(threadId, runId), "preparing");

        // A's scheduling fails; the claim is free, but its fail belongs to stretch k.
        yield* Deferred.succeed(failRead, undefined);
        yield* Fiber.join(replay);
        const exit = yield* Deferred.await(replayFail);
        assert.equal(
          Exit.isFailure(exit) ? refusalReason(exit.cause) : "committed",
          STRETCH_CHANGED,
        );
        assert.equal(yield* runStatus(threadId, runId), "preparing");

        yield* atLine.release;
        yield* Fiber.join(retry);
        yield* released(threadId, "command:replay-x");
      }).pipe(Effect.provide(harness.layer));
    }),
);
