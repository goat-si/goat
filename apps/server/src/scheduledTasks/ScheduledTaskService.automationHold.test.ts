// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as AutomationHold from "../automationHold.ts";
import {
  webhookTaskInput,
  pullRequestBody,
  requestFor,
  withService,
} from "./ScheduledTaskService.webhook.testkit.ts";

it.effect(
  "rejects webhooks without claiming or dispatching while held and accepts after release",
  () =>
    Effect.gen(function* () {
      const hold = yield* AutomationHold.makeInMemory({
        reason: "channel-copy",
        heldAt: "2026-10-25T00:00:00.000Z",
      });
      yield* withService(({ service, launches, sql }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            yield* webhookTaskInput({
              schedule: {
                type: "webhook",
                signature: {
                  header: "x-hub-signature-256",
                  encoding: "hex",
                  prefix: "sha256=",
                  secret: "held-secret",
                },
              },
            }),
          );
          assert.equal(
            (yield* service.triggerWebhook(requestFor(task, { token: "wrong" })))._tag,
            "not_found",
          );
          assert.equal(
            (yield* service.triggerWebhook(requestFor(task)))._tag,
            "rejected_signature",
          );
          const request = requestFor(task, {
            relayDeliveryId: "held-delivery",
            headers: {
              "x-hub-signature-256": `sha256=${NodeCrypto.createHmac("sha256", "held-secret").update(pullRequestBody).digest("hex")}`,
            },
          });
          const result = yield* service.triggerWebhook(request).pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.equal(result.failure._tag, "WebhookAutomationHeldError");
          }
          assert.equal(yield* Queue.size(launches), 0);
          assert.isEmpty(yield* sql`SELECT * FROM scheduled_task_webhook_relay_deliveries`);
          yield* hold.release;
          const accepted = yield* service.triggerWebhook(request);
          assert.equal(accepted._tag === "accepted" && accepted.outcome, "accepted");
          yield* Queue.take(launches);
        }),
      ).pipe(Effect.provideService(AutomationHold.AutomationHold, hold));
    }),
);
