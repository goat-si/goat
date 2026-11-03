import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, RunId, ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as HostPressureMonitor from "../fleet/pressure/HostPressureMonitor.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import { idleEffectWorker } from "./EffectWorker.testkit.ts";
import {
  layerTest,
  makeThread,
  modelSelection,
  providerInstanceId,
  threadCreatedEvent,
} from "./FoundationPersistence.testkit.ts";

it.effect.each(["startup", "shutdown"] as const)(
  "start lane retains never-attempted starts through %s recovery",
  (trigger) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      for (const n of [0, 1, 2, 3]) {
        const threadId = ThreadId.make(`thread:start-lane-recovery:${n}`);
        const runId = RunId.make(`run:start-lane-recovery:${n}`);
        const commandId = CommandId.make(`command:start-lane-recovery:${n}`);
        yield* sink.commitCommand({
          commandId,
          threadId,
          commandType: "test",
          acceptedAt: now,
          events: [
            threadCreatedEvent({
              id: `event:start-lane-recovery:thread:${n}`,
              thread: makeThread(threadId, now),
              now,
            }),
            {
              id: EventId.make(`event:start-lane-recovery:run:${n}`),
              type: "run.created",
              threadId,
              runId,
              providerInstanceId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal: 1,
                providerInstanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: MessageId.make(`message:start-lane-recovery:${n}`),
                rootNodeId: null,
                activeAttemptId: null,
                status: "starting",
                queuePosition: null,
                requestedAt: now,
                startedAt: null,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
          effects: [
            {
              id: `effect:start-lane-recovery:${n}`,
              commandId,
              threadId,
              request: { type: "provider-turn.start", runId },
            },
          ],
        });
      }
      assert.equal(
        Option.getOrThrow(yield* outbox.claimNext({ workerId: "old", leaseDurationMs: 30_000 })).id,
        "effect:start-lane-recovery:0",
      );
      yield* outbox.retry({
        effectId: "effect:start-lane-recovery:0",
        workerId: "old",
        error: "failed",
        delayMs: 60_000,
      });
      assert.equal(
        Option.getOrThrow(yield* outbox.claimNext({ workerId: "old", leaseDurationMs: 30_000 })).id,
        "effect:start-lane-recovery:1",
      );
      assert.isTrue(
        Option.isNone(yield* outbox.claimNext({ workerId: "old", leaseDurationMs: 30_000 })),
      );
      const fresh = Context.get(
        yield* Layer.build(Layer.fresh(EffectOutbox.layer)),
        EffectOutbox.EffectOutboxV2,
      );
      const recovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provideService(EffectOutbox.EffectOutboxV2, fresh),
        Effect.provide(ServerSettings.layerTest()),
        Effect.provideService(EffectWorker.OrchestrationEffectWorkerV2, idleEffectWorker()),
      );
      yield* recovery.reconcile(trigger);
      assert.equal(
        Option.getOrThrow(yield* fresh.get("effect:start-lane-recovery:1")).status,
        "cancelled",
      );
      assert.deepInclude(Option.getOrThrow(yield* fresh.get("effect:start-lane-recovery:0")), {
        status: "cancelled",
        attemptCount: 1,
      });
      assert.equal(
        (yield* projections.getThreadProjection(ThreadId.make("thread:start-lane-recovery:0")))
          .runs[0]?.status,
        "cancelled",
      );

      const started = yield* Queue.unbounded<string>();
      const worker = Context.get(
        yield* Layer.build(
          EffectWorker.layer.pipe(
            Layer.provide(
              Layer.merge(
                Layer.succeed(EffectOutbox.EffectOutboxV2, fresh),
                Layer.mock(EffectWorker.OrchestrationEffectExecutorV2)({
                  execute: (effect) => Queue.offer(started, effect.id).pipe(Effect.asVoid),
                }),
              ),
            ),
          ),
        ),
        EffectWorker.OrchestrationEffectWorkerV2,
      );
      for (const n of [2, 3]) {
        const threadId = ThreadId.make(`thread:start-lane-recovery:${n}`);
        assert.equal(
          (yield* projections.getThreadProjection(threadId)).runs[0]?.status,
          "starting",
        );
        assert.deepInclude(Option.getOrThrow(yield* fresh.get(`effect:start-lane-recovery:${n}`)), {
          status: "pending",
          attemptCount: 0,
        });
        assert.isTrue(yield* worker.runStartOnce);
        assert.equal(yield* Queue.take(started), `effect:start-lane-recovery:${n}`);
        assert.equal(
          Option.getOrThrow(yield* fresh.get(`effect:start-lane-recovery:${n}`)).status,
          "succeeded",
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerTest.pipe(
          Layer.provide(
            Layer.mock(HostPressureMonitor.HostPressureMonitor)({
              current: Effect.succeed({
                level: "critical",
                since: "2026-01-01T00:00:00.000Z",
                reasons: [],
                loadPerCore: null,
                eventLoopDelayMs: null,
              }),
            }),
          ),
        ),
      ),
    ),
);
