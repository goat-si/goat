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
