import type {
  ChannelInputId,
  ChannelOutboundKind,
  ChannelReplyAddress,
  ChannelTask,
} from "@goat/contracts";

import type * as ChannelLedger from "./ChannelLedger.ts";
import { numberedChoiceLines } from "./channelDecisionChoices.ts";
import { deliveryIdFor } from "./channelIds.ts";

/** One reply to the sender, with any choices shaped for the channel it goes to. */
export const replyDelivery = (input: {
  readonly causeKey: string;
  readonly destination: ChannelReplyAddress;
  readonly kind: ChannelOutboundKind;
  readonly text: string;
  readonly inputId?: ChannelInputId | undefined;
  readonly task?: ChannelTask | undefined;
  readonly mentionActorId?: string | undefined;
  readonly options?: ReadonlyArray<string> | undefined;
}): ChannelLedger.ChannelOutboxInsert => {
  const deliveryId = deliveryIdFor(input.causeKey);
  const options = input.options === undefined || input.options.length === 0 ? [] : input.options;
  // The GOAT app shows choices as buttons. Slack keeps the labels for Block Kit buttons and
  // also lists them, so a notification or a typed number still works. iMessage and the rest
  // get the numbered list only.
  const buttons = input.destination.kind === "goat" && options.length > 0;
  const listed = !buttons && options.length > 0;
  const text = listed ? input.text + "\n" + numberedChoiceLines(options) : input.text;
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
      ...(input.inputId === undefined ? {} : { inReplyToInputId: input.inputId }),
      ...(input.task === undefined
        ? {}
        : { taskId: input.task.taskId, taskVersion: input.task.version }),
      ...(input.mentionActorId === undefined ? {} : { mentionActorId: input.mentionActorId }),
      ...(keepOptions ? { options } : {}),
    },
  };
};
