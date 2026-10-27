import { assert, it } from "@effect/vitest";
import { EventId, MessageId, type OrchestrationV2DomainEvent } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  withWebhookService,
  webhookTaskInput,
} from "../scheduledTasks/ScheduledRunFixture.testkit.ts";
import { answerExcerpt } from "./ProjectionLatestAnswer.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { applyToProjection, emptyProjection } from "./ProjectionStore.ts";

it("flattens an answer to one line and cuts it without splitting a character", () => {
  assert.equal(answerExcerpt("  Done.\n\nPR   opened  "), "Done. PR opened");
  assert.isUndefined(answerExcerpt(" \n "));
  const long = answerExcerpt("a".repeat(158) + "😀😀");
  assert.equal(long, "a".repeat(158) + "…");
  assert.isAtMost(long?.length ?? 0, 160);
});

it.effect(
  "a completed run leaves its root answer on the thread shell, kept through reopen, stale thread payloads and replay",
  () =>
    withWebhookService(
      ({ service, sink, projections }) =>
        Effect.gen(function* () {
          const task = (yield* service.upsert(
            yield* webhookTaskInput({ schedule: { type: "interval", everyMs: 60000 } }),
          )).task;
          const ran = yield* service.runNow({ id: task.id });
          const initial = yield* projections.getThreadProjection(ran.threadId!);
          const run = initial.runs[0]!;
          const prompt = initial.messages[0]!;
          const now = yield* DateTime.now;
          const later = DateTime.add(now, { seconds: 1 });
          const message = (id: string, text: string, extra: object = {}) => ({
            id: EventId.make(id + "-" + text.length),
            type: "message.updated" as const,
            threadId: run.threadId,
            occurredAt: now,
            payload: {
              ...prompt,
              id: MessageId.make(id),
              role: "assistant" as const,
              runId: run.id,
              nodeId: run.rootNodeId,
              text,
              streaming: false,
              createdAt: now,
              updatedAt: now,
              ...extra,
            },
          });
          const runEvent = (id: string, payload: typeof run) => ({
            id: EventId.make(id),
            type: "run.updated" as const,
            threadId: run.threadId,
            occurredAt: later,
            payload,
          });
          const events: OrchestrationV2DomainEvent[] = [
            message("draft", "Looking into it"),
            message("answer", "Fixed the bug.\nPR #12 is open.", {
              createdAt: later,
              updatedAt: later,
            }),
            // A draft edited after the answer is still not the answer.
            message("draft", "Looking into it, again", { updatedAt: later }),
            message("streaming", "Half a thought", { createdAt: later, streaming: true }),
            runEvent("completed", { ...run, status: "completed", completedAt: later }),
            runEvent("reopened", { ...run, status: "running", completedAt: null }),
            {
              id: EventId.make("stale-thread"),
              type: "thread.metadata-updated",
              threadId: run.threadId,
              occurredAt: later,
              payload: initial.thread,
            },
          ];
          yield* sink.write({ events });
          const expected = "Fixed the bug. PR #12 is open.";
          assert.equal(
            (yield* projections.getThreadShell(run.threadId))?.latestAnswerExcerpt,
            expected,
          );
          assert.equal(
            (yield* projections.getThreadProjection(run.threadId)).thread.latestAnswerExcerpt,
            expected,
          );

          const stored = yield* sink.stream({ threadId: run.threadId }).pipe(
            Stream.takeUntil((s) => s.event.id === EventId.make("stale-thread")),
            Stream.runCollect,
          );
          const replayEvents = stored
            .map((s) => s.event)
            .filter((e) => e.threadId === run.threadId);
          const created = replayEvents.find((e) => e.type === "thread.created");
          if (created?.type !== "thread.created") return assert.fail("thread.created not stored");
          let replay = emptyProjection(created);
          for (const event of replayEvents) replay = applyToProjection(replay, event);
          assert.equal(replay.thread.latestAnswerExcerpt, expected);
          const memory = yield* ProjectionStore.ProjectionStoreV2.pipe(
            Effect.provide(ProjectionStore.layerMemory),
          );
          for (const event of replayEvents) yield* memory.apply(event);
          assert.equal((yield* memory.getThreadShell(run.threadId))?.latestAnswerExcerpt, expected);
        }),
      { runStatus: "queued" },
    ),
);
