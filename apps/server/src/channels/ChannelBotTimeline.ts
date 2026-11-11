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
  type ChannelQuestionId,
  type ChannelTimelineRecord,
  type ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelTransport from "./ChannelTransport.ts";
import { timelineIdsFor } from "./channelIds.ts";
import { ANSWER_DECISION_HANDLED, personMessageEntry } from "./channelPersonMessage.ts";

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
>()("goat/channels/ChannelBotTimeline") {}

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
    const persistenceFailed = () => new ChannelGatewayError({ reason: "persistence_failed" });

    /**
     * Reception's decision about an answer goes onto the person's own message, in the thread it
     * was sent to. A bot gone, or moved to another thread since, gets nothing: that thread is
     * no longer shown, and the new one never had the message.
     */
    const recordAnswerDecision = (
      message: ChannelOutboundMessage,
      answersQuestionId: ChannelQuestionId | null,
    ) =>
      Effect.gen(function* () {
        if (message.inReplyToInputId === undefined) {
          return yield* new ChannelGatewayError({ reason: "invalid_input" });
        }
        const stored = yield* ledger
          .getInput(message.inReplyToInputId)
          .pipe(Effect.mapError(persistenceFailed));
        const origin = stored?.message.replyAddress;
        if (stored === undefined || origin?.kind !== "goat") return;
        const bot = yield* ledger
          .getBotById(stored.ownerId, stored.botId)
          .pipe(Effect.mapError(persistenceFailed));
        if (bot?.bot.threadId !== origin.threadId) return;
        yield* timeline.record({
          threadId: origin.threadId,
          record: {
            recordKey: "input:" + stored.snapshot.inputId,
            entry: { ...personMessageEntry(stored, { answersQuestionId }), answerDecided: true },
          },
          revision: "decided",
        });
      });

    /** The conversation, owner and bot a delivery belongs to, from the task or input it answers. */
    const sourceOf = (message: ChannelOutboundMessage) =>
      Effect.gen(function* () {
        const taskId = message.chip?.taskId ?? message.taskId;
        if (message.inReplyToInputId !== undefined) {
          const input = yield* ledger.getInput(message.inReplyToInputId);
          if (input !== undefined) {
            const { ownerId, botId } = input;
            return { conversationId: input.snapshot.conversationId, ownerId, botId };
          }
        }
        if (taskId !== undefined) {
          const task = yield* ledger.getTask(taskId);
          if (task !== undefined) {
            const { ownerId, botId } = task;
            return { conversationId: task.task.conversationId, ownerId, botId };
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
        if (message.personAnswer !== undefined) {
          yield* recordAnswerDecision(message, message.personAnswer.answersQuestionId);
          const acceptedAt = DateTime.formatIso(yield* DateTime.now);
          return {
            deliveryId: message.deliveryId,
            acceptedAt,
            externalMessageId: ANSWER_DECISION_HANDLED,
          };
        }
        const source = yield* sourceOf(message);
        // A delivery goes to the current thread of the bot its input or task belongs to, so work
        // outstanding when that bot's thread was replaced still reports back.
        const current =
          source === undefined
            ? undefined
            : yield* ledger
                .getBotById(source.ownerId, source.botId)
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
            ...(message.taskGeneration === undefined
              ? {}
              : { taskGeneration: message.taskGeneration }),
            ...(message.options === undefined ? {} : { options: message.options }),
            ...(message.questionId === undefined ? {} : { questionId: message.questionId }),
            ...(message.questionKind === undefined ? {} : { questionKind: message.questionKind }),
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
