import { assert, it } from "@effect/vitest";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import {
  waitForSpan,
  webhookTaskInput,
  requestFor,
  withWebhookService as withService,
} from "./ScheduledRunFixture.testkit.ts";

it.effect("finalizes admitted instruction overflow and releases the webhook replay claim", () =>
  withService(({ service, sql }) =>
    Effect.gen(function* () {
      const prompt = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 100);
      const input = yield* webhookTaskInput({
        prompt,
        threadId: ThreadId.make("bound"),
        notificationPolicy: "important_updates",
        schedule: { type: "webhook", dedupe: { replayKey: "{{headers.delivery-id}}" } },
      });
      const task = (yield* service.upsert(input)).task;
      assert.equal(task.prompt, prompt);
      const request = requestFor(task, { headers: { "delivery-id": "same" } });
      yield* waitForSpan(
        service.triggerWebhook(request).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              assert.equal(result._tag, "accepted");
              assert.equal(result._tag === "accepted" ? result.outcome : undefined, "accepted");
            }),
          ),
        ),
        "ScheduledTaskService.runWebhookDelivery",
      );
      const receipts = yield* sql<{
        dispatch_status: string;
        status: string;
      }>`SELECT dispatch_status,status FROM scheduled_task_runs`;
      assert.equal(receipts[0]?.dispatch_status, "failed");
      assert.equal(receipts[0]?.status, "failed");
      const first = (yield* service.list()).tasks[0]!;
      assert.equal(first.runCount, 1);
      assert.equal(first.prompt, prompt);
      const retry = yield* waitForSpan(
        service.triggerWebhook(request).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              assert.equal(result._tag, "accepted");
              assert.equal(result._tag === "accepted" ? result.outcome : undefined, "accepted");
            }),
          ),
        ),
        "ScheduledTaskService.runWebhookDelivery",
      );
      assert.isFalse(retry._tag === "accepted" && retry.outcome === "duplicate");
      assert.equal((yield* service.list()).tasks[0]?.runCount, 2);
    }),
  ),
);
