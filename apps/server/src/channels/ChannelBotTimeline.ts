/**
 * ChannelBotTimeline - writes GOAT bot messages and task chips into the bot thread.
 *
 * Every write is the internal `channel.timeline.record` command, so the bot never gets a provider
 * run. The command id carries the record key and what changed, which keeps a retried write
 * idempotent while letting a chip move to its next version.
 *
 * The same module provides the GOAT transport: the delivery worker hands it outbox rows whose
 * destination is the GOAT bot, exactly like it hands Slack rows to the Slack transport.
 *
 * @module ChannelBotTimeline
 */
import {
  ChannelGatewayError,
  type ChannelMessageKind,
  type ChannelMessageMeta,
  type ChannelOutboundMessage,
  type ChannelTimelineRecord,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelTransport from "./ChannelTransport.ts";
import { timelineIdsFor } from "./channelIds.ts";

export class ChannelBotTimeline extends Context.Service<
  ChannelBotTimeline,
  {
    /** Records one entry and returns the orchestration sequence that committed it. */
    readonly record: (input: {
      readonly threadId: ThreadId;
      readonly record: ChannelTimelineRecord;
      readonly revision: string;
    }) => Effect.Effect<number, ChannelGatewayError>;
  }
>()("t3/channels/ChannelBotTimeline") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  return ChannelBotTimeline.of({
    record: (input) =>
      threads
        .dispatch({
          type: "channel.timeline.record",
          commandId: timelineIdsFor(input.threadId, input.record.recordKey, input.revision)
            .commandId,
          threadId: input.threadId,
          record: input.record,
        })
        .pipe(
          Effect.map((result) => result.sequence),
          Effect.tapError((cause) =>
            Effect.logWarning("channel.timeline.record failed", { cause }),
          ),
          Effect.mapError(() => new ChannelGatewayError({ reason: "persistence_failed" })),
        ),
  });
});

export const layer = Layer.effect(ChannelBotTimeline, make);

const messageKindFor = (kind: ChannelOutboundMessage["kind"]): ChannelMessageKind => {
  switch (kind) {
    case "receipt":
    case "task_chip":
      return "receipt";
    case "result":
      return "result";
    case "question":
      return "question";
    case "failure":
      return "failure";
  }
};

/** Registers the GOAT bot as a transport for as long as the surrounding scope lives. */
export const layerGoatTransport = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ChannelTransport.ChannelTransportRegistry;
    const timeline = yield* ChannelBotTimeline;
    const ledger = yield* ChannelLedger.ChannelLedger;

    /** The conversation and owner a delivery belongs to, from the task or input it answers. */
    const sourceOf = (message: ChannelOutboundMessage) =>
      Effect.gen(function* () {
        const taskId = message.chip?.taskId ?? message.taskId;
        if (message.inReplyToInputId !== undefined) {
          const input = yield* ledger.getInput(message.inReplyToInputId);
          if (input !== undefined) {
            return { conversationId: input.snapshot.conversationId, ownerId: input.ownerId };
          }
        }
        if (taskId !== undefined) {
          const task = yield* ledger.getTask(taskId);
          if (task !== undefined) {
            return { conversationId: task.task.conversationId, ownerId: task.ownerId };
          }
        }
        return undefined;
      }).pipe(Effect.mapError(() => new ChannelGatewayError({ reason: "persistence_failed" })));

    const send = (message: ChannelOutboundMessage) =>
      Effect.gen(function* () {
        const destination = message.destination;
        if (destination.kind !== "goat") {
          return yield* new ChannelGatewayError({ reason: "invalid_input" });
        }
        const source = yield* sourceOf(message);
        // An owner has one bot. A delivery addressed to a bot that was deleted and replaced since
        // goes to the current one, so outstanding work still reports back.
        const current =
          source === undefined
            ? undefined
            : yield* ledger
                .getBot(source.ownerId)
                .pipe(
                  Effect.mapError(() => new ChannelGatewayError({ reason: "persistence_failed" })),
                );
        const threadId = current?.bot.threadId ?? destination.threadId;
        if (message.kind === "task_chip") {
          if (message.chip === undefined) {
            return yield* new ChannelGatewayError({ reason: "invalid_input" });
          }
          yield* timeline.record({
            threadId,
            record: {
              recordKey: "task-chip:" + message.chip.taskId,
              entry: { type: "task_chip", chip: message.chip },
            },
            revision: "v" + message.chip.taskVersion,
          });
        } else {
          if (source === undefined) {
            return yield* new ChannelGatewayError({ reason: "not_found" });
          }
          const meta: ChannelMessageMeta = {
            conversationId: source.conversationId,
            originKind: "goat",
            kind: messageKindFor(message.kind),
            ...(message.inReplyToInputId === undefined
              ? {}
              : { inReplyToInputId: message.inReplyToInputId }),
            ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
          };
          yield* timeline.record({
            threadId,
            record: {
              recordKey: "delivery:" + message.deliveryId,
              entry: { type: "message", role: "assistant", text: message.text, meta },
            },
            revision: "send",
          });
        }
        const acceptedAt = DateTime.formatIso(yield* DateTime.now);
        return { deliveryId: message.deliveryId, acceptedAt };
      });

    yield* registry.register({ kind: "goat", send });
  }),
);
