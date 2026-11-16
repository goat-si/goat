import { CommandId, MessageId, type ThreadId, type RunId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { launchInput } from "../testkit/threadLaunchInput.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";
import * as PreparationOrphans from "./PreparationOrphans.ts";

/**
 * A launch cut between its commit and its preparation: its run is preparing and nothing prepares
 * it. Launching the returned input resumes that launch.
 */
export const orphanRun = Effect.fn("test.orphanRun")(function* (name: string) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const input = launchInput({
    command: `command:${name}`,
    thread: `thread:${name}`,
    message: name,
  });
  yield* threads.dispatch({
    type: "thread.create",
    commandId: input.commandId,
    threadId: input.threadId,
    projectId: input.projectId,
    title: input.title,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    branch: null,
    worktreePath: null,
    createdBy: input.createdBy,
    creationSource: input.creationSource,
  });
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`${input.commandId}:initial-message`),
    threadId: input.threadId,
    messageId: MessageId.make(`${name}:id`),
    text: name,
    attachments: [],
    modelSelection: input.modelSelection,
    dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
    createdBy: input.createdBy,
    creationSource: input.creationSource,
  });
  const run = (yield* threads.getThreadProjection(input.threadId)).runs[0];
  if (run?.status !== "preparing") return yield* Effect.die("the orphan run was not created");
  return { input, threadId: input.threadId, runId: run.id };
});

export const runStatus = Effect.fn("test.runStatus")(function* (threadId: ThreadId, runId: RunId) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  return (yield* threads.getThreadProjection(threadId)).runs.find((run) => run.id === runId)
    ?.status;
});

/** Settles once a preparation under the given command released the run to its provider. */
export const released = Effect.fn("test.released")(function* (threadId: ThreadId, command: string) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* threads.streamStoredEventsFrom({ threadId }).pipe(
    Stream.filter(
      (stored) =>
        stored.commandId === CommandId.make(`${command}:release`) &&
        stored.event.type === "run.updated",
    ),
    Stream.runHead,
  );
});

export type PassOutcome = "read" | "fail" | "die";

/**
 * Runs the orphan check with its read and its fail dispatch observed. A pass calls the read right
 * after its sleep ends, before any suspension, so after TestClock.adjust the started count is
 * settled. A pass with nothing to fail does only in-memory work after its read returns.
 */
export const makeOrphanProbe = Effect.gen(function* () {
  const mode = yield* Ref.make<PassOutcome>("read");
  const started = yield* Ref.make(0);
  const reads = yield* Queue.unbounded<PassOutcome>();
  const fails = yield* Queue.unbounded<RunId>();
  const wrapRead = (read: PreparationOrphans.SuspectRead): PreparationOrphans.SuspectRead =>
    Ref.update(started, (count) => count + 1).pipe(
      Effect.andThen(Ref.get(mode)),
      Effect.flatMap((outcome) => {
        if (outcome === "fail")
          return Queue.offer(reads, outcome).pipe(
            Effect.andThen(
              Effect.fail(
                new SqlError({ reason: classifySqliteError(new Error("sqlite is unavailable")) }),
              ),
            ),
          );
        if (outcome === "die")
          return Queue.offer(reads, outcome).pipe(
            Effect.andThen(Effect.die(new Error("unexpected read defect"))),
          );
        return read.pipe(Effect.tap(() => Queue.offer(reads, outcome)));
      }),
    );
  const layerThreads = Layer.effect(
    ThreadManagement.ThreadManagementService,
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      return ThreadManagement.ThreadManagementService.of({
        ...threads,
        dispatch: (command) =>
          threads
            .dispatch(command)
            .pipe(
              Effect.tap(() =>
                command.type === "prepared-run.fail"
                  ? Queue.offer(fails, command.runId)
                  : Effect.void,
              ),
            ),
      });
    }),
  );
  return {
    mode,
    /** The check, reading threads and claims from the layer it is given. */
    layer: PreparationOrphans.layerWithRead(wrapRead).pipe(Layer.provide(layerThreads)),
    /** Advances one interval; how that pass's read ended, or "none" if no pass ran. */
    pass: Effect.gen(function* () {
      yield* TestClock.adjust(PreparationOrphans.PASS_INTERVAL);
      if ((yield* Ref.getAndSet(started, 0)) === 0) return "none" as const;
      return yield* Queue.take(reads);
    }),
    /** The run of the next fail the check dispatched, once that dispatch returned. */
    failed: Queue.take(fails),
    failCount: Queue.size(fails),
  };
});
