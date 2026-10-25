import * as AutomationHold from "../automationHold.ts";
import { assert, it } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as EventSink from "./EventSink.ts";
import * as QuestionEscalationService from "./QuestionEscalationService.ts";
import {
  layerTest,
  setup,
  questionEvents,
  ids,
  records,
  awaitMessage,
} from "./QuestionEscalationService.testkit.ts";

it.layer(layerTest)("QuestionEscalationService", (it) => {
  it.effect("held: no recovered question dispatch; release: the launcher receives it", () =>
    Effect.gen(function* () {
      const hold = yield* AutomationHold.makeInMemory({
        reason: "channel-copy",
        heldAt: "2026-10-25T00:00:00.000Z",
      });
      const suffix = "automation-hold";
      yield* setup(suffix);
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({ events: yield* questionEvents(suffix) });
      let sequenceReads = 0;
      yield* Effect.gen(function* () {
        const service = yield* QuestionEscalationService.QuestionEscalationService;
        const saved = yield* awaitMessage(ids(suffix).messageId);
        sequenceReads = 0;
        yield* service.start();
        yield* TestClock.adjust(0);
        assert.strictEqual(sequenceReads, 0);
        assert.lengthOf((yield* records(suffix)).messages, 0);
        yield* hold.release;
        yield* service.awaitSubscribed;
        yield* Fiber.join(saved);
        assert.lengthOf((yield* records(suffix)).messages, 1);
      }).pipe(
        Effect.provide(QuestionEscalationService.layer),
        Effect.provideService(EventSink.EventSinkV2, {
          ...sink,
          latestSequence: () =>
            Effect.sync(() => {
              sequenceReads += 1;
            }).pipe(Effect.andThen(sink.latestSequence())),
        }),
        Effect.provideService(AutomationHold.AutomationHold, hold),
        Effect.scoped,
      );
    }),
  );
});
