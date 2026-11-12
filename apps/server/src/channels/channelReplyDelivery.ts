import type {
  ChannelInputId,
  ChannelOutboundKind,
  ChannelQuestionId,
  ChannelReplyAddress,
  ChannelTask,
} from "@goat/contracts";

import type * as ChannelLedger from "./ChannelLedger.ts";
import { numberedChoiceLines, wordChoiceLine } from "./channelDecisionChoices.ts";
import { deliveryIdFor } from "./channelIds.ts";

/**
 * The request a turn's answer replies to. Clients show an assistant result without one as an
 * unprompted update, so the answer would read as a second message after the receipt.
 */
export const turnAnswerReplyTo = (task: ChannelTask, kind: ChannelOutboundKind) =>
  task.kind === "turn" && kind === "result" ? task.originInputId : undefined;

/** One reply to the sender, with any choices shaped for the channel it goes to. */
export const replyDelivery = (input: {
  readonly causeKey: string;
  readonly destination: ChannelReplyAddress;
  readonly kind: ChannelOutboundKind;
  readonly text: string;
  readonly inputId?: ChannelInputId | undefined;
  /** Links the message to an input without making this the input's own reply row. */
  readonly replyTo?: ChannelInputId | undefined;
  readonly task?: ChannelTask | undefined;
  /** The attempt the message speaks for when it is not the task's current one. */
  readonly taskGeneration?: number | undefined;
  readonly mentionActorId?: string | undefined;
  readonly options?: ReadonlyArray<string> | undefined;
  readonly questionId?: ChannelQuestionId | undefined;
  /** Progress before the answer; see ChannelOutboundMessage.interim. */
  readonly interim?: boolean | undefined;
  /** Only the task's own question narration passes it; see ChannelMessageMeta.questionKind. */
  readonly questionKind?: "task" | undefined;
  /** Choices answered only by their words: approvals, where a number names no request. */
  readonly byWord?: boolean | undefined;
}): ChannelLedger.ChannelOutboxInsert => {
  const deliveryId = deliveryIdFor(input.causeKey);
  const options = input.options === undefined || input.options.length === 0 ? [] : input.options;
  // The GOAT app shows choices as buttons. Slack keeps the labels for Block Kit buttons and
  // also lists them, so a notification or a typed reply still works. iMessage and the rest get
  // the list only: numbered, or for choices by word the words to reply with.
  const buttons = input.destination.kind === "goat" && options.length > 0;
  const listed = !buttons && options.length > 0;
  const choices = input.byWord === true ? wordChoiceLine(options) : numberedChoiceLines(options);
  const text = listed ? input.text + "\n" + choices : input.text;
  const keepOptions = buttons || (input.destination.kind === "slack" && options.length > 0);
  return {
    deliveryId,
    causeKey: input.causeKey,
    ...(input.inputId === undefined ? {} : { inputId: input.inputId }),
    ...(input.task === undefined ? {} : { taskId: input.task.taskId }),
    message: {
      deliveryId,
      destination: input.destination,
      kind: input.kind,
      text,
      ...((input.inputId ?? input.replyTo) === undefined
        ? {}
        : { inReplyToInputId: input.inputId ?? input.replyTo }),
      ...(input.task === undefined
        ? {}
        : {
            taskId: input.task.taskId,
            taskVersion: input.task.version,
            taskGeneration: input.taskGeneration ?? input.task.generation,
          }),
      ...(input.mentionActorId === undefined ? {} : { mentionActorId: input.mentionActorId }),
      ...(keepOptions ? { options } : {}),
      ...(input.questionId === undefined ? {} : { questionId: input.questionId }),
      ...(input.interim === true ? { interim: true as const } : {}),
      ...(input.questionKind === undefined ? {} : { questionKind: input.questionKind }),
    },
  };
};
