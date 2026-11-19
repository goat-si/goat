import type { CommandId, OrchestrationV2DomainEvent } from "@goat/contracts";
import * as Effect from "effect/Effect";
import {
  CommandReceiptStoreWriteError,
  type CommandReceiptStoreV2,
} from "./CommandReceiptStore.ts";
import type { EventSinkV2Shape } from "./EventSinkShape.ts";
import type { makeScheduledTaskAppender } from "./ScheduledTaskCompletionBatch.ts";

export interface AtomicLaunchReceipt {
  readonly commandId: CommandId;
  readonly createEventCount: number;
}

export const makeCommandEventAppender = (
  append: ReturnType<typeof makeScheduledTaskAppender>,
  receipts: CommandReceiptStoreV2["Service"],
) =>
  Effect.fn("EventSink.appendCommandEvents")(function* (
    input: Parameters<EventSinkV2Shape["commitCommand"]>[0],
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
  ) {
    const legacy = input.initialMessageReceipt;
    if (legacy === undefined) return yield* append({ commandId: input.commandId, events });
    const creation = yield* append({
      commandId: input.commandId,
      events: events.slice(0, legacy.createEventCount),
    });
    const message = yield* append({
      commandId: legacy.commandId,
      events: events.slice(legacy.createEventCount),
    });
    const sequence = message.at(-1)?.sequence;
    if (sequence === undefined || !message.some(({ event }) => event.type === "run.created"))
      return yield* new CommandReceiptStoreWriteError({
        commandId: legacy.commandId,
        cause: "The initial message did not create a run.",
      });
    const reserved = yield* receipts.insertIfAbsent({
      commandId: legacy.commandId,
      threadId: input.threadId,
      commandType: "message.dispatch",
      acceptedAt: input.acceptedAt,
      resultSequence: sequence,
      status: "accepted",
      error: null,
    });
    if (!reserved)
      return yield* new CommandReceiptStoreWriteError({
        commandId: legacy.commandId,
        cause: "The initial message command ID is already reserved.",
      });
    return [...creation, ...message];
  });
