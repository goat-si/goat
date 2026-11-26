import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Tracer from "effect/Tracer";
import { RelayClientTracer, withRelayClientTracing } from "@goat/shared/relayTracing";

import {
  requestFor,
  webhookTaskInput,
  withWebhookService as withService,
} from "./ScheduledRunFixture.testkit.ts";

it.effect("a relay-delivered webhook keeps the run it starts off the relay tracer", () =>
  withService(({ service, launches }) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(yield* webhookTaskInput());
      const relaySpans: Array<string> = [];
      const relayTracer = Tracer.make({
        span: (options) => {
          relaySpans.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      });

      const result = yield* service
        .triggerWebhook(requestFor(task))
        .pipe(
          withRelayClientTracing,
          Effect.provideService(RelayClientTracer, Option.some(relayTracer)),
        );
      assert.equal(result._tag, "accepted");
      yield* Queue.take(launches);

      assert.include(relaySpans, "ScheduledTaskService.triggerWebhook");
      assert.notInclude(relaySpans, "ScheduledTaskService.runWebhookDelivery");
      assert.notInclude(relaySpans, "ScheduledTaskService.runTask");
    }),
  ),
);
