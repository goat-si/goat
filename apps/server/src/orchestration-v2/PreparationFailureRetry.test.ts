import { assert, it } from "@effect/vitest";
import { CommandId, GitCommandError, RunId, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { makeHarness, project } from "./testkit/ThreadLaunchHarness.ts";
import { launchInput } from "./testkit/threadLaunchInput.ts";

it.effect("returns from prepareRun without retrying a scheduling failure", () =>
  Effect.gen(function* () {
    const rejected = yield* Deferred.make<void>();
    let rejectedWrites = 0;
    const harness = makeHarness({
      dispatch: (command, dispatch) =>
        command.type !== "prepared-run.fail"
          ? dispatch(command)
          : Effect.suspend(() => {
              rejectedWrites += 1;
              return Deferred.succeed(rejected, undefined).pipe(
                Effect.andThen(Effect.die("SQLITE_FULL: database or disk is full")),
              );
            }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      yield* launches.prepareRun({
        commandId: CommandId.make("command:prepare:missing-thread"),
        threadId: ThreadId.make("thread:prepare:missing-thread"),
        runId: RunId.make("run:prepare:missing-thread"),
      });
      yield* Deferred.await(rejected);
      yield* TestClock.adjust("1 second");
      assert.equal(rejectedWrites, 1);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("fails a run whose preparation failure could not be stored until storage recovers", () =>
  Effect.gen(function* () {
    const storageFull = yield* Deferred.make<void>();
    let rejectedWrites = 0;
    let preparations = 0;
    const harness = makeHarness({
      fetchWorktreeBaseCommit: () =>
        Effect.sync(() => preparations++).pipe(
          Effect.andThen(
            Effect.fail(
              new GitCommandError({
                operation: "GitVcsDriver.fetchRemote",
                command: "git",
                cwd: project.workspaceRoot,
                detail: "Git could not reach the remote.",
                exitCode: 128,
              }),
            ),
          ),
        ),
      dispatch: (command, dispatch) =>
        command.type !== "prepared-run.fail"
          ? dispatch(command)
          : Effect.suspend(() => {
              if (rejectedWrites >= 2) return dispatch(command);
              rejectedWrites += 1;
              return Deferred.succeed(storageFull, undefined).pipe(
                Effect.andThen(
                  Effect.fail(
                    new Orchestrator.OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause: new Error("SQLITE_FULL: database or disk is full"),
                    }),
                  ),
                ),
              );
            }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = launchInput({
        command: "command:launch:storage-full",
        thread: "thread:launch:storage-full",
        message: "First message",
        workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
      });
      const launched = yield* launches.launch(input);
      yield* Deferred.await(storageFull);
      yield* TestClock.adjust("0 seconds");
      yield* launches.launch(input);
      yield* TestClock.adjust("0 seconds");
      assert.equal(preparations, 1);
      yield* TestClock.adjust("1 second");
      assert.equal(rejectedWrites, 2);
      yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" && stored.event.payload.status === "failed",
        ),
        Stream.runHead,
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);
