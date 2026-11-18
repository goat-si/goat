import { CommandId, EventId, MessageId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  finishFollowupWithAwaitedTask,
  followupRosterSettlement,
  layerTest,
  recoverChildWithIndependentParentWake,
  seedUnheldFollowup,
} from "./DelegatedCompletionDelivery.testkit.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";

const testLayer = Layer.fresh(Layer.merge(layerTest, ProviderContinuationRequests.layer));

it.effect("holds a finished follow-up for its awaited provider task", () =>
  Effect.gen(function* () {
    const { pending } = yield* finishFollowupWithAwaitedTask();
    assert.isTrue(yield* pending);
  }).pipe(Effect.provide(testLayer)),
);
it.effect("settles a follow-up when its task exits a roster that still holds unrelated work", () =>
  Effect.gen(function* () {
    const { otherOwner, owned, unattributed, result, tasks, replayTasks } =
      yield* followupRosterSettlement();
    assert.equal(owned, "run:held-followup");
    assert.equal(otherOwner, "run:unrelated-followup");
    assert.isUndefined(unattributed);
    assert.deepEqual(replayTasks, tasks);
    assert.isString(result);
  }).pipe(Effect.provide(testLayer)),
);
it.effect("idles the parent task when runtime recovery holds its queued follow-up", () =>
  Effect.gen(function* () {
    const { sink, orchestrator, threadId, taskId, childThreadId } = yield* seedUnheldFollowup();
    const afterSequence = yield* sink.latestSequence();
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    yield* sink.stream({ threadId, afterSequence, eventType: "subagent.updated" }).pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "subagent.updated" &&
          event.payload.id === taskId &&
          event.payload.status === "idle",
      ),
      Stream.runHead,
    );
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    assert.equal(child.runs.at(-1)?.status, "queued");
    assert.isTrue(child.runs.at(-1)?.queueHeld);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("re-offers only the parent run that owns the recovering child", () =>
  Effect.gen(function* () {
    const wake = yield* recoverChildWithIndependentParentWake();
    assert.equal(wake.delegatedCompletion?.parentRunId, "run:reoffer:owner");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("binds a terminal wake once and leaves its follow-up settled on a late report", () =>
  Effect.gen(function* () {
    const { sink, orchestrator, providerThread, childThreadId, threadId, followup, taskId, now } =
      yield* finishFollowupWithAwaitedTask();
    const dispatch = (id: string) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:followup-wake:${id}`),
        threadId: childThreadId,
        messageId: MessageId.make(`message:followup-wake:${id}`),
        text: "Background work completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "provider",
        notification: {
          source: { kind: "command" },
          outcome: "completed",
          summary: "Work completed",
          aboutRunId: followup.id,
        },
      });
    yield* dispatch("terminal");
    assert.isTrue((yield* dispatch("terminal")).replayed);
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    const wake = child.runs.find((run) => run.userMessageId === "message:followup-wake:terminal");
    assert.isDefined(wake);
    assert.equal(wake.delegatedTaskId, taskId);

    yield* sink.write({
      events: [
        {
          id: EventId.make("event:followup-wake:settled-roster"),
          type: "provider-thread.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: { ...providerThread, pendingBackgroundTasks: [] },
        },
        {
          id: EventId.make("event:followup-wake:settled-run"),
          type: "run.updated",
          threadId: childThreadId,
          runId: wake.id,
          occurredAt: now,
          payload: { ...wake, status: "completed", startedAt: now, completedAt: now },
        },
      ],
    });
    yield* orchestrator.recoverDelegatedTask(childThreadId, { sourceRunId: wake.id });
    const { subagents } = yield* orchestrator.getThreadProjection(threadId);
    assert.isString(subagents.find((task) => task.id === taskId)?.result);
    yield* dispatch("late");
    const latest = yield* orchestrator.getThreadProjection(threadId);
    assert.sameMembers(
      latest.subagents.map((task) => task.id),
      subagents.map((task) => task.id),
    );
  }).pipe(Effect.provide(testLayer)),
);
