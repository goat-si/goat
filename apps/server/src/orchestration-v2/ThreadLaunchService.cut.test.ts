import { assert, it } from "@effect/vitest";
import { CommandId, GitCommandError, type RunId, type ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { makeHarness, project } from "./testkit/ThreadLaunchHarness.ts";
import { preparationSettled } from "./testkit/preparationSettled.ts";
import { launchInput } from "./testkit/threadLaunchInput.ts";

/** Settles once the preparation started by `commandId` released its run. */
const released = (threadId: ThreadId, commandId: CommandId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.streamStoredEventsFrom({ threadId }).pipe(
      Stream.filter((stored) => stored.commandId === CommandId.make(`${commandId}:release`)),
      Stream.runHead,
    );
    return (yield* threads.getThreadRecords(threadId, ["runs"])).runs;
  });

const worktreeFailed = new GitCommandError({
  operation: "GitVcsDriver.createWorktree",
  command: "git",
  cwd: project.workspaceRoot,
  detail: "Worktree creation failed.",
  exitCode: 128,
});

it.effect.each([
  { dispatch: "message.dispatch", cut: "after the commit" },
  { dispatch: "message.dispatch", cut: "while the dispatch waits for the thread lock" },
  { dispatch: "prepared-run.retry", cut: "after the commit" },
  { dispatch: "prepared-run.retry", cut: "while the dispatch waits for the thread lock" },
] as const)("#3593: a $dispatch cut $cut leaves no run stuck preparing", ({ dispatch, cut }) =>
  Effect.gen(function* () {
    const committed = yield* Deferred.make<void>();
    const dispatching = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const created = yield* Deferred.make<void>();
    const resumeCreate = yield* Deferred.make<void>();
    const openWorktree = yield* Deferred.make<void>();
    // Set when the cut lands inside the dispatch after its commit, so the recovery path ran.
    const cutAfterCommit = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    const lockCase = cut !== "after the commit";
    let worktreeFailures = dispatch === "prepared-run.retry" ? 1 : 0;
    const harness = makeHarness({
      createWorktree: (input) =>
        worktreeFailures-- > 0
          ? Effect.fail(worktreeFailed)
          : Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(openWorktree)),
              Effect.as({
                worktree: {
                  path: "/repo-worktrees/cut",
                  refName: input.newRefName,
                  headSha: "abc",
                },
              } as never),
            ),
      beforeDispatch: (command) =>
        command.type === dispatch ? Deferred.succeed(dispatching, undefined) : Effect.void,
      afterDispatch: (command) =>
        command.type === "thread.create" && lockCase && dispatch === "message.dispatch"
          ? Deferred.succeed(created, undefined).pipe(Effect.andThen(Deferred.await(resumeCreate)))
          : command.type === dispatch && !lockCase
            ? Deferred.succeed(committed, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.onInterrupt(() => Deferred.succeed(cutAfterCommit, undefined)),
              )
            : Effect.void,
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const unlock = yield* Deferred.make<void>();
      const holdLock = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const held = yield* Deferred.make<void>();
          yield* locks
            .withLock(
              threadId,
              Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(unlock))),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(held);
        });
      const input = launchInput({
        command: `command:cut:${dispatch}:${lockCase ? "lock" : "commit"}`,
        thread: `thread:cut:${dispatch}:${lockCase ? "lock" : "commit"}`,
        message: "First message",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const retryCommandId = CommandId.make(`${input.commandId}:retry`);
      let runId: RunId | undefined;
      if (dispatch === "prepared-run.retry") {
        const launched = yield* launches.launch(input);
        yield* preparationSettled(launched.threadId);
        runId = launched.projection.runs[0]!.id;
      }
      const call =
        runId === undefined
          ? launches.launch(input).pipe(Effect.asVoid)
          : launches
              .retryPreparation({ commandId: retryCommandId, threadId: input.threadId, runId })
              .pipe(Effect.asVoid);
      const before = (yield* threads
        .getThreadRecords(input.threadId, ["runs"])
        .pipe(Effect.orElseSucceed(() => ({ runs: [] })))).runs.map((run) => run.status);
      if (lockCase && dispatch === "prepared-run.retry") yield* holdLock(input.threadId);
      const running = yield* call.pipe(Effect.forkChild);
      if (lockCase && dispatch === "message.dispatch") {
        yield* Deferred.await(created);
        yield* holdLock(input.threadId);
        yield* Deferred.succeed(resumeCreate, undefined);
      }
      yield* Deferred.await(lockCase ? dispatching : committed);
      running.interruptUnsafe();
      yield* Deferred.succeed(lockCase ? unlock : resume, undefined);
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(running)));
      if (lockCase) {
        yield* Deferred.succeed(unlock, undefined);
        // The cut stopped the dispatch before it committed: the runs are as they were.
        const after = (yield* threads.getThreadRecords(input.threadId, ["runs"])).runs;
        assert.deepEqual(
          after.map((run) => run.status),
          before,
        );
        return;
      }
      assert.isTrue(yield* Deferred.isDone(cutAfterCommit));
      const startedInTime = yield* Deferred.await(started).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({ duration: "1 minute", orElse: () => Effect.succeed(false) }),
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 minute");
      assert.isTrue(yield* Fiber.join(startedInTime), "the cut run's preparation never started");
      yield* Deferred.succeed(openWorktree, undefined);
      const runs = yield* released(
        input.threadId,
        dispatch === "prepared-run.retry" ? retryCommandId : input.commandId,
      );
      assert.notInclude(
        runs.map((run) => run.status),
        "preparing",
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);
