import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CommandId, EventId, GitCommandError, ScheduledTaskId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { makeHarness, project } from "./testkit/ThreadLaunchHarness.ts";
import { projectId, modelSelection } from "./testkit/threadLaunchInput.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as EventSink from "./EventSink.ts";

it.effect.each(["automatic", "manual"] as const)(
  "public preparation retry keeps %s unread failure after quiet success on the same run",
  (unread) => {
    const harness = makeHarness({
      fetchWorktreeBaseCommit: () =>
        Effect.fail(
          new GitCommandError({
            operation: "GitVcsDriver.fetchWorktreeBase",
            command: "git",
            cwd: project.workspaceRoot,
            reason: "timed_out",
            detail: "Synthetic preparation failure",
          }),
        ),
    });
    const tasksLayer = Tasks.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          harness.layer,
          NodeCrypto.layer,
          Scheduler.layer,
          Layer.mock(Secrets.SecretRequests)({}),
        ),
      ),
    );
    const sinkLayer = RuntimeLayer.layerEventSink.pipe(Layer.provide(harness.layer));
    return Effect.gen(function* () {
      const tasks = yield* Tasks.ScheduledTaskService;
      const threads = yield* Threads.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const task = (yield* tasks.upsert({
        id: ScheduledTaskId.make("retry-task"),
        title: "Synthetic",
        prompt: "Synthetic",
        enabled: false,
        notificationPolicy: "failed_runs_only",
        schedule: { type: "interval", everyMs: 60000 },
        projectId,
        threadId: null,
        workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
      })).task;
      const fired = yield* tasks.runNow({ id: task.id });
      const threadId = fired.threadId!;
      yield* threads.streamStoredEventsFrom({ threadId }).pipe(
        Stream.filter((s) => s.event.type === "run.updated" && s.event.payload.status === "failed"),
        Stream.runHead,
      );
      const failed = yield* threads.getThreadProjection(threadId);
      const run = failed.runs[0]!;
      assert.equal(run.status, "failed");
      assert.isNotNull(failed.thread.notificationCompletedAt);
      assert.deepStrictEqual(failed.thread.notificationCompletedAt, run.completedAt);
      assert.isTrue(
        failed.thread.lastVisitedAt === null ||
          DateTime.isGreaterThan(
            failed.thread.notificationCompletedAt!,
            failed.thread.lastVisitedAt,
          ),
      );
      if (unread === "manual") {
        yield* threads.dispatch({
          type: "thread.mark-unread",
          commandId: CommandId.make("mark-failure-unread"),
          threadId,
        });
      }
      yield* threads.dispatch({
        type: "prepared-run.retry",
        commandId: CommandId.make("retry"),
        threadId,
        runId: run.id,
      });
      const retry = yield* threads.getThreadProjection(threadId);
      assert.equal(retry.runs[0]?.id, run.id);
      assert.equal(retry.runs[0]?.status, "preparing");
      assert.deepStrictEqual(
        retry.thread.notificationCompletedAt,
        failed.thread.notificationCompletedAt,
      );
      if (unread === "automatic") {
        assert.isUndefined(retry.thread.markedUnreadCompletionAt);
        assert.deepStrictEqual(retry.thread.lastVisitedAt, failed.thread.lastVisitedAt);
        assert.isTrue(
          retry.thread.lastVisitedAt === null ||
            DateTime.isGreaterThan(
              retry.thread.notificationCompletedAt!,
              retry.thread.lastVisitedAt,
            ),
        );
      }
      const at = DateTime.add(yield* DateTime.now, { seconds: 1 });
      yield* sink.write({
        events: [
          {
            id: EventId.make("quiet-retry-success"),
            type: "run.updated",
            threadId,
            occurredAt: at,
            payload: { ...retry.runs[0]!, status: "completed", completedAt: at },
          },
        ],
      });
      const quiet = yield* threads.getThreadProjection(threadId);
      assert.equal(quiet.runs[0]?.completionNotification, "silent");
      assert.deepStrictEqual(
        quiet.thread.notificationCompletedAt,
        failed.thread.notificationCompletedAt,
      );
      if (unread === "automatic") {
        assert.isUndefined(quiet.thread.markedUnreadCompletionAt);
        assert.deepStrictEqual(quiet.thread.lastVisitedAt, failed.thread.lastVisitedAt);
        assert.isTrue(
          quiet.thread.lastVisitedAt === null ||
            DateTime.isGreaterThan(
              quiet.thread.notificationCompletedAt!,
              quiet.thread.lastVisitedAt,
            ),
        );
        return;
      }
      assert.deepStrictEqual(quiet.thread.markedUnreadCompletionAt, run.completedAt);
      assert.isTrue(
        DateTime.isGreaterThan(quiet.thread.markedUnreadCompletionAt!, quiet.thread.lastVisitedAt!),
      );
      yield* threads.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("visit"),
        threadId,
        visitedAt: DateTime.formatIso(at),
      });
      const visited = yield* threads.getThreadProjection(threadId);
      assert.isFalse(
        DateTime.isGreaterThan(
          visited.thread.markedUnreadCompletionAt!,
          visited.thread.lastVisitedAt!,
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, tasksLayer, sinkLayer)));
  },
);
