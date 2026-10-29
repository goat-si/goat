import { assert, it } from "@effect/vitest";
import { EventId, type OrchestrationV2StoredEvent } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ChannelDeliveryWorker from "./ChannelDeliveryWorker.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelTransport from "./ChannelTransport.ts";
import { taskIdFor } from "./channelIds.ts";
import { goatInput, rpcContext, setupBot } from "./testkit/ChannelHarness.ts";
import { makeSessionHarness } from "./testkit/ChannelSessionHarness.ts";

it.effect(
  "the domain event observer delivers a streaming first line while ordinary passes are blocked",
  () => {
    const harness = makeSessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const worker = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
      const sink = yield* EventSink.EventSinkV2;
      const registry = yield* ChannelTransport.ChannelTransportRegistry;
      const input = yield* gateway.ingest(goatInput("Inspect disk", "event-observer"), rpcContext);
      yield* runtime.drain;
      const task = (yield* ledger.getTask(taskIdFor(input.inputId, 0)))!.task;
      const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      const blocked = yield* Deferred.make<void>();
      const sent = yield* Deferred.make<void>();
      const transport = Option.getOrThrow(yield* registry.resolve("goat"));
      yield* registry.register({
        ...transport,
        send: (message) =>
          transport
            .send(message)
            .pipe(
              Effect.tap(() =>
                message.inReplyToInputId === input.inputId
                  ? Deferred.succeed(sent, undefined)
                  : Effect.void,
              ),
            ),
      });
      yield* Layer.build(
        ChannelRuntime.layerBackground.pipe(
          Layer.provide(
            Layer.succeed(ChannelRuntime.ChannelRuntime, {
              ...runtime,
              runPass: Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Effect.never)),
            }),
          ),
          Layer.provide(
            Layer.succeed(EventSink.EventSinkV2, {
              ...sink,
              stream: () => Stream.fromQueue(events),
            }),
          ),
        ),
      );
      yield* Deferred.await(blocked);
      const item = harness.assistant(task, "Checking disk usage.\n", true);
      yield* Queue.offer(events, {
        sequence: 1,
        commandId: null,
        event: {
          id: EventId.make("first-line-event"),
          threadId: item.threadId,
          occurredAt: yield* DateTime.now,
          type: "turn-item.updated",
          payload: item,
        },
      });
      yield* Deferred.await(sent);
      yield* worker.settleReceipts;
      assert.strictEqual(
        (yield* ledger.getInput(input.inputId))?.snapshot.reply?.text,
        "Checking disk usage.",
      );
      assert.strictEqual((yield* ledger.getTask(task.taskId))?.task.status, "running");
    }).pipe(Effect.provide(harness.layer));
  },
);
