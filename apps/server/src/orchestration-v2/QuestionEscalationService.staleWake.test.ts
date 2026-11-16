import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as QuestionEscalationService from "./QuestionEscalationService.ts";
import {
  answer,
  holdLauncher,
  ids,
  layerTest,
  records,
  seed,
  setup,
} from "./QuestionEscalationService.testkit.ts";

it.layer(layerTest)("QuestionEscalationService", (it) => {
  it.effect(
    "a queued wake for a question closed while nobody listened is dropped, and the question refuses an answer",
    () =>
      Effect.gen(function* () {
        const suffix = "stale-wake";
        const engine = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* setup(suffix);
        yield* holdLauncher(suffix);
        // Not started: the reconciler misses the closing event, as across a restart.
        yield* seed(suffix);
        const wake = (yield* records(suffix)).runs.find(
          (r) => r.userMessageId === ids(suffix).messageId,
        )!;
        assert.equal(wake.status, "queued");
        yield* answer(suffix, { type: "user" }, true);
        const hold = (yield* records(suffix)).runs.find(
          (r) => r.userMessageId === MessageId.make(`hold:${suffix}`),
        )!;
        const now = yield* DateTime.now;
        yield* projections.apply({
          id: EventId.make(`hold-finished:${suffix}`),
          type: "run.updated",
          threadId: hold.threadId,
          runId: hold.id,
          occurredAt: now,
          payload: { ...hold, status: "completed", completedAt: now },
        });
        yield* engine.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`resume:${suffix}`),
          threadId: ids(suffix).launcherId,
        });
        const after = yield* records(suffix);
        assert.equal(after.runs.find((r) => r.id === wake.id)?.status, "cancelled");
        assert.notEqual(
          after.runs.find((r) => r.userMessageId === MessageId.make(`unrelated:${suffix}`))?.status,
          "queued",
        );

        const refused = yield* answer(suffix, { type: "user" }, false).pipe(Effect.flip);
        assert.include(refused.message, "so it can no longer be answered.");
      }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
});
