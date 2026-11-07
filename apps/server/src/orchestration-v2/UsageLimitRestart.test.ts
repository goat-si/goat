import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, RunId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import { createThread, createRun } from "./ProjectionRecovery.testkit.ts";
import { createOrchestrationV2TurnItemVisibility } from "@goat/shared/orchestrationV2Timeline";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";

const layerTest = ProviderRuntimeRecovery.layer.pipe(
  Layer.provideMerge(
    EventSink.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          EventStore.layer,
          ProjectionStore.layer,
          EffectOutbox.layer,
          IdAllocator.layer,
        ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
  ),
  Layer.provide(ServerSettings.layerTest()),
);
it.effect.each(["unsent", "started", "untagged", "disabled", "different", "preserved"] as const)(
  "reconciles a %s usage-limit continuation without duplicating its prompt",
  (scenario) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      const now = yield* DateTime.now;
      const failedAt = DateTime.add(now, { hours: -2 });
      const resetAt = DateTime.formatIso(DateTime.add(now, { hours: -1 }));
      const source = RunId.make(`run:thread:recovery:limit-${scenario}:1`);
      const requestId = CommandId.make(`limit-request:${scenario}`);
      const threadId = yield* createThread(`limit-${scenario}`, {
        limitRecovery: {
          runId: source,
          requestId,
          resetAt,
          autoResume: scenario !== "disabled",
        },
      });
      yield* createRun(threadId, "failed", { startedAt: failedAt, completedAt: failedAt });
      yield* projections.apply({
        id: EventId.make(`error:${scenario}`),
        type: "turn-item.updated",
        threadId,
        runId: source,
        occurredAt: failedAt,
        payload: {
          id: TurnItemId.make(`error:${scenario}`),
          threadId,
          runId: source,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "failed",
          title: "Usage limit",
          startedAt: failedAt,
          completedAt: failedAt,
          updatedAt: failedAt,
          type: "error",
          failure: {
            class: "usage_limit",
            message: "Limit reached",
            resetAt,
            code: "usageLimitExceeded",
            retryable: null,
          },
        },
      });
      const runId = yield* createRun(threadId, scenario === "started" ? "running" : "starting", {
        ordinal: 2,
        startedAt: scenario === "started" ? now : null,
        ...(scenario === "untagged"
          ? {}
          : {
              usageLimitContinuationOfRunId:
                scenario === "different" ? RunId.make("another-source") : source,
            }),
      });
      const messageId = MessageId.make(`message:${runId}`);
      yield* projections.apply({
        id: EventId.make(`item:${scenario}`),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`item:${scenario}`),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          createdBy: "agent",
          creationSource: "server",
          messageId,
          inputIntent: "turn_start",
          text: "Continue where you left off.",
          attachments: [],
        },
      });
      if (scenario === "preserved") {
        yield* (yield* EffectOutbox.EffectOutboxV2).enqueue([
          {
            id: "effect:preserved-limit",
            commandId: CommandId.make("command:preserved-limit"),
            threadId,
            request: { type: "provider-turn.start", runId },
          },
        ]);
      }
      yield* recovery.reconcile("startup");
      const projection = yield* projections.getThreadProjection(threadId);
      const item = projection.turnItems.find(
        (candidate) => candidate.type === "user_message" && candidate.runId === runId,
      );
      assert.isDefined(item);
      if (scenario === "unsent") {
        assert.notEqual(projection.thread.limitRecovery?.requestId, requestId);
        assert.equal(item?.type === "user_message" ? item.inputIntent : null, "queued_turn");
        const candidates = yield* projections.getLimitRecoveryCandidates({
          now,
          autoResume: true,
          snooze: false,
        });
        const candidate = candidates.find((entry) => entry.id === threadId);
        assert.isDefined(candidate);
        if (!candidate) return;
        const retry = limitRecoveryCommand(candidate, true, DateTime.toEpochMillis(now));
        const old = limitRecoveryCommand(
          { ...candidate, limitRecovery: { ...candidate.limitRecovery!, requestId } },
          true,
          DateTime.toEpochMillis(now),
        );
        assert.equal(retry?.type, "message.dispatch");
        assert.notEqual(retry?.commandId, old?.commandId);
      } else {
        assert.equal(projection.thread.limitRecovery?.requestId, requestId);
        assert.equal(
          item?.type === "user_message" ? item.inputIntent : null,
          scenario === "disabled" || scenario === "different" ? "queued_turn" : "turn_start",
        );
      }
      const visible = createOrchestrationV2TurnItemVisibility({
        runs: projection.runs,
        attempts: projection.attempts,
        items: projection.turnItems,
      });
      assert.equal(
        item === undefined ? true : visible(item),
        scenario === "started" || scenario === "untagged" || scenario === "preserved",
      );
      yield* recovery.reconcile("startup");
      assert.equal(
        (yield* projections.getThread(threadId)).limitRecovery?.requestId,
        projection.thread.limitRecovery?.requestId,
      );
    }).pipe(Effect.provide(layerTest)),
);
