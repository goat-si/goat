import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ScheduledTaskId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { createWatchingThread, delegate, layerTest, send } from "./ThreadStop.testkit.ts";

it.effect("startup resends an independent scheduled run in a formerly delegated child", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const sql = yield* SqlClient.SqlClient;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const parent = ThreadId.make("former-child-parent");
    yield* createWatchingThread(parent, 4);
    yield* send(parent, "parent", "start_immediately");
    const child = yield* delegate(parent, "original delegated work", "always");
    const parentState = yield* orchestrator.getThreadProjection(parent);
    const childState = yield* orchestrator.getThreadProjection(child);
    const task = parentState.subagents.find((item) => item.childThreadId === child)!;
    const oldRun = childState.runs[0]!;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("former-child-task-completed"),
          type: "subagent.updated",
          threadId: parent,
          occurredAt: now,
          payload: {
            ...task,
            status: "completed",
            result: "done",
            completedAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("former-child-run-completed"),
          type: "run.updated",
          threadId: child,
          runId: oldRun.id,
          occurredAt: now,
          payload: { ...oldRun, status: "completed", completedAt: now },
        },
      ],
    });
    const commandId = CommandId.make("former-child-scheduled-command");
    const messageId = MessageId.make("former-child-scheduled-message");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId,
      threadId: child,
      messageId,
      text: "Scheduled follow-up",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      scheduledTaskId: ScheduledTaskId.make("former-child-schedule"),
      createdBy: "agent",
      creationSource: "server",
    });
    const before = yield* orchestrator.getThreadProjection(child);
    const scheduled = before.runs.find((run) => run.userMessageId === messageId)!;
    assert.equal(scheduled.status, "starting");
    assert.isUndefined(scheduled.delegatedTaskId);
    assert.equal(
      before.attempts.find((attempt) => attempt.id === scheduled.activeAttemptId)?.inputDelivery,
      "unsent",
    );
    yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'failed' WHERE command_id = ${commandId} AND effect_type = 'provider-turn.start'`;
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
          Layer.succeed(EventSink.EventSinkV2, sink),
          Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
          Layer.succeed(IdAllocator.IdAllocatorV2, ids),
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
        ),
      ),
    );
    yield* recovery.reconcile("startup");
    yield* recovery.drainDeferredResends(locks);
    const resent = yield* outbox.get(`effect:recovery-resend:${scheduled.id}:1`);
    assert.isTrue(Option.isSome(resent));
    if (Option.isSome(resent)) assert.equal(resent.value.commandId, commandId);
    yield* recovery.drainDeferredResends(locks);
    assert.isTrue(Option.isNone(yield* outbox.get(`effect:recovery-resend:${scheduled.id}:2`)));
    const starts: string[] = [];
    const workerLayer = EffectWorker.layerWithOptions({ workerId: "former-child-recovery" }).pipe(
      Layer.provide(
        Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
          execute: (effect) =>
            Effect.sync(() => {
              if (effect.id === `effect:recovery-resend:${scheduled.id}:1`) starts.push(effect.id);
            }),
        }),
      ),
      Layer.provide(Layer.succeed(EffectOutbox.EffectOutboxV2, outbox)),
    );
    yield* Effect.gen(function* () {
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(32);
    }).pipe(Effect.provide(workerLayer));
    assert.deepEqual(starts, [`effect:recovery-resend:${scheduled.id}:1`]);
  }).pipe(
    Effect.provide(Layer.mergeAll(layerTest, IdAllocator.layer, ThreadCommandExecutor.layer)),
  ),
);
