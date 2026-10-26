import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { CommandPolicyCapabilityUnsupportedError } from "./CommandPolicy.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  adapter,
  instanceId,
  layerForAdapter,
  layerTest,
  createWatchingThread,
  send,
} from "./ThreadStop.testkit.ts";

it.effect.each(["validation_error", "provider_error"] as const)(
  "records %s on queued start failure",
  (kind) => {
    let rejectQueuedStart = false;
    const threadId = ThreadId.make(`thread:queued-start-cause:${kind}`);
    const failingAdapter = {
      ...adapter,
      getCapabilities: () =>
        rejectQueuedStart
          ? Effect.fail(
              kind === "validation_error"
                ? new CommandPolicyCapabilityUnsupportedError({
                    commandId: CommandId.make("command:queued-start-cause"),
                    threadId,
                    providerInstanceId: instanceId,
                    capability: "context_handoff",
                    detail: "Context transfer unavailable",
                  })
                : "Provider startup unavailable",
            )
          : Effect.succeed(CodexProviderCapabilitiesV2),
    } as ProviderAdapter.ProviderAdapterV2["Service"];
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* createWatchingThread(threadId, 1);
      yield* send(threadId, "active", "start_immediately");
      yield* send(threadId, "queued", "queue_after_active");
      const before = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(before.runs[1]?.status, "queued");
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make(`event:queued-start-cause:${kind}`),
        type: "run.updated",
        threadId,
        runId: before.runs[0]!.id,
        occurredAt: now,
        payload: { ...before.runs[0]!, status: "completed", completedAt: now },
      });
      rejectQueuedStart = true;
      yield* orchestrator.resumeQueuedRuns;
      const failed = (yield* orchestrator.getThreadProjection(threadId)).runs[1];
      assert.equal(failed?.status, "failed");
      assert.equal(failed?.terminationCause?.kind, kind);
    }).pipe(Effect.provide(layerForAdapter(failingAdapter)));
  },
);

it.effect("records preparation failure and clears cause on retry", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:preparation-cause");
    yield* createWatchingThread(threadId, 1);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("command:preparation-cause:send"),
      threadId,
      messageId: MessageId.make("message:preparation-cause"),
      text: "Prepare",
      attachments: [],
      dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    assert.equal(run.status, "preparing");
    yield* orchestrator.dispatch({
      type: "prepared-run.fail",
      commandId: CommandId.make("command:preparation-cause:fail"),
      threadId,
      runId: run.id,
      failure: {
        class: "validation_error",
        message: "Workspace unavailable",
        code: null,
        retryable: false,
      },
    });
    assert.equal(
      (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.terminationCause?.kind,
      "preparation_failed",
    );
    yield* orchestrator.dispatch({
      type: "prepared-run.retry",
      commandId: CommandId.make("command:preparation-cause:retry"),
      threadId,
      runId: run.id,
    });
    const retried = (yield* orchestrator.getThreadProjection(threadId)).runs[0];
    assert.equal(retried?.status, "preparing");
    assert.isUndefined(retried?.terminationCause);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("records archive cancellation of a queued run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const archiveThreadId = ThreadId.make("thread:archive-cause");
    yield* createWatchingThread(archiveThreadId, 1);
    yield* send(archiveThreadId, "active", "start_immediately");
    yield* send(archiveThreadId, "queued", "queue_after_active");
    const archivedRun = (yield* orchestrator.getThreadProjection(archiveThreadId)).runs[1]!;
    assert.equal(archivedRun.status, "queued");
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("command:archive-cause"),
      threadId: archiveThreadId,
    });
    assert.equal(
      (yield* orchestrator.getThreadProjection(archiveThreadId)).runs[1]?.terminationCause?.kind,
      "thread_archive",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "%s cancels buffered wakes and preserves durable queued messages",
  (type) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make(`thread:stop-buffered:${type}`);
      yield* createWatchingThread(threadId, 5);
      yield* send(threadId, "active", "start_immediately");
      yield* send(threadId, "user follow-up", "queue_after_active");
      for (const creationSource of ["provider", "server"] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`notification:${type}:${creationSource}`),
          threadId,
          messageId: MessageId.make(`notification:${type}:${creationSource}`),
          text: "Background activity updated",
          attachments: [],
          createdBy: "agent",
          creationSource,
          notification: {
            source: { kind: "background_task" },
            outcome: "updated",
            summary: "Background activity updated",
          },
          dispatchMode: { type: "queue_after_active" },
        });
      }
      const before = yield* orchestrator.getThreadProjection(threadId);
      const buffered = before.runs.find((run) =>
        before.messages.some(
          (message) => message.id === run.userMessageId && message.creationSource === "provider",
        ),
      )!;
      const stop = {
        commandId: CommandId.make(`stop:${type}`),
        threadId,
        reason: "Stopped by an agent: test",
      };
      yield* orchestrator.dispatch(
        type === "run.interrupt"
          ? { ...stop, type, runId: before.runs[0]!.id, holdQueue: true }
          : { ...stop, type },
      );
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(stopped.runs.find((run) => run.id === buffered.id)?.status, "cancelled");
      assert.deepEqual(stopped.runs.find((run) => run.id === buffered.id)?.terminationCause, {
        kind: "agent_stop",
      });
      assert.equal(
        stopped.attempts.find((attempt) => attempt.runId === buffered.id)?.status,
        "cancelled",
      );
      assert.equal(
        stopped.nodes.find((node) => node.id === buffered.rootNodeId)?.status,
        "cancelled",
      );
      assert.deepEqual(
        stopped.runs.filter((run) => run.status === "queued").map((run) => run.queueHeld),
        [true, true],
      );
    }).pipe(Effect.provide(layerTest)),
);
