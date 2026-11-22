import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  webhookTaskInput,
  requestFor,
  withWebhookService as withService,
} from "./ScheduledRunFixture.testkit.ts";

it.effect("drops an emoji split by the delivery log's prompt limit", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput({ prompt: "{{body.text}}" }));
      const limit = 64 * 1024;
      const frameOpen = "<webhook-data-000000000000>".length;
      // The emoji's high surrogate is the last code unit the log keeps.
      const bodyText = JSON.stringify({ text: `${"a".repeat(limit - 1 - frameOpen)}😀 tail` });
      yield* service.triggerWebhook(
        requestFor(task, { bodyText, body: new TextEncoder().encode(bodyText) }),
      );
      const [summary] = (yield* service.listWebhookDeliveries({ id: task.id })).deliveries;
      const { delivery } = yield* service.getWebhookDelivery({
        id: task.id,
        deliveryId: summary!.id,
      });
      assert.equal(delivery.renderedPrompt!.slice(-3), "aaa");
      assert.equal(delivery.renderedPrompt!.length, limit - 1);
    }),
  ),
);
