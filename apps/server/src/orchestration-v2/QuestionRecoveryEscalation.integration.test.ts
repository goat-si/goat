import { assert, it } from "@effect/vitest";
import { ProviderSessionId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as QuestionEscalationService from "./QuestionEscalationService.ts";
import {
  awaitEvent,
  ids,
  layerTest,
  questionEvents,
  records,
  seed,
  setup,
  start,
} from "./QuestionEscalationService.testkit.ts";

const base = Layer.mergeAll(layerTest, IdAllocator.layer, ServerSettings.layerTest());
const layer = Layer.mergeAll(base, ProviderRuntimeRecoveryService.layer.pipe(Layer.provide(base)));

it.layer(layer)("question recovery escalation", (it) => {
  it.effect("recovery re-emits a pending question without waking its launcher twice", () =>
    Effect.gen(function* () {
      const suffix = "recovered-once";
      yield* setup(suffix);
      const service = yield* start;
      const events = (yield* questionEvents(suffix)).map((event) =>
        event.type === "runtime-request.updated"
          ? {
              ...event,
              payload: {
                ...event.payload,
                responseCapability: {
                  type: "live" as const,
                  providerSessionId: ProviderSessionId.make("lost-session"),
                },
              },
            }
          : event,
      );
      yield* seed(suffix, events);
      yield* service.sweep;
      const recovered = yield* awaitEvent(
        ({ event }) =>
          event.type === "runtime-request.updated" &&
          event.payload.id === ids(suffix).requestId &&
          event.payload.responseCapability.type === "message",
      );
      const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
      yield* recovery.recover;
      yield* Fiber.join(recovered);
      yield* service.sweep;
      yield* recovery.recover;
      yield* service.sweep;
      const saved = yield* records(suffix);
      assert.lengthOf(
        saved.messages.filter((message) => message.id === ids(suffix).messageId),
        1,
      );
      assert.lengthOf(
        saved.runs.filter((run) => run.userMessageId === ids(suffix).messageId),
        1,
      );
    }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
});
