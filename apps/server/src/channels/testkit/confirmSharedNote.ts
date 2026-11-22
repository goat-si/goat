import type { ChannelInboundMessage, ChannelInputId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as ChannelGateway from "../ChannelGateway.ts";
import type { ChannelIngressContext } from "../ChannelIngressContext.ts";
import * as ChannelLedger from "../ChannelLedger.ts";

export const confirmSharedNote = Effect.fn("channelTest.confirmSharedNote")(function* (
  inputId: ChannelInputId,
  message: ChannelInboundMessage,
  context: ChannelIngressContext,
) {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const action = (yield* ledger.getInput(inputId))?.decision?.action;
  const option =
    action?.type === "clarify"
      ? action.options?.find((choice) => choice.startsWith("For all bots ("))
      : undefined;
  if (option === undefined) return;
  yield* (yield* ChannelGateway.ChannelGateway).ingest(
    {
      ...message,
      idempotencyKey: message.idempotencyKey + "-confirmed",
      externalMessageId: message.externalMessageId + "-confirmed",
      text: option,
    },
    context,
  );
});
