import { assert } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";

export const assertQueuedWatchWake = (modelSelection: ModelSelection) => {
  // A thread watching a pull request, with a wake queued behind a running turn.
  const queuedWatchWake = (prefix: string) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make(`${prefix}-auto-settle`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${prefix}-create`),
        threadId,
        projectId: ProjectId.make(`${prefix}-project`),
        title: "Queued watch wake",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 7 };
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`${prefix}-start`),
        threadId,
        ...key,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/7", source: "agent" },
      });
      const started = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
      assert.isDefined(started);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${prefix}-active`),
        threadId,
        messageId: MessageId.make(`${prefix}-active`),
        text: "Merge it",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const wakeMessageId = MessageId.make(prefix);
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make(`${prefix}-sync`),
        threadId,
        ...key,
        startedAt: started.startedAt,
        watch: { ...started, headSha: "merged", wakes: 1 },
        wake: {
          messageId: wakeMessageId,
          text: "Update",
          notification: { source: { kind: "monitor" }, outcome: "updated", summary: "#7 merged" },
        },
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const activeRun = before.runs.find((run) => run.status === "starting");
      const wakeRun = before.runs.find((run) => run.userMessageId === wakeMessageId);
      assert.isDefined(activeRun);
      assert.isDefined(wakeRun);
      assert.equal(wakeRun.status, "queued");
      assert.notEqual(wakeRun.queueHeld, true);
      return { threadId, activeRun, wakeRun };
    });

  // regression: #29898 settle on merge cancelled a watch wake queued behind the finished run
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const { threadId, activeRun, wakeRun } = yield* queuedWatchWake("pr-watch-held-wake");
    const now = yield* DateTime.now;
    // Startup recovery's command prefix skips the completion reaction, as after a restart.
    yield* eventSink.write({
      commandId: CommandId.make("command:runtime-reconcile:pr-watch-held-wake"),
      events: [
        {
          id: EventId.make("pr-watch-held-wake-completed"),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...activeRun, status: "completed", completedAt: now },
        },
        {
          id: EventId.make("pr-watch-held-wake-hold"),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...wakeRun, queueHeld: true },
        },
      ],
    });
    const autoSettle = (commandId: string) =>
      Effect.flatMap(orchestrator.getThreadShell(threadId), (shell) =>
        orchestrator.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make(commandId),
          threadId,
          snapshotAt: shell?.updatedAt ?? now,
        }),
      );
    const early = yield* autoSettle("pr-watch-held-wake-early").pipe(Effect.exit);
    assert.equal(early._tag, "Failure");

    yield* TestClock.adjust(Orchestrator.QUEUED_TURN_START_GRACE_MS);
    yield* autoSettle("pr-watch-held-wake-late");
    const after = yield* orchestrator.getThreadProjection(threadId);
    assert.isNotNull(after.thread.settledAt);
    assert.equal(after.runs.find((run) => run.id === wakeRun.id)?.status, "cancelled");
  });
};
