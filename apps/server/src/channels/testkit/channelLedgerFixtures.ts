import {
  ChannelReceptionId,
  ChannelOutboundMessage,
  ChannelTaskId,
  type ChannelIngestResult,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as ChannelLedger from "../ChannelLedger.ts";
import { deliveryIdFor } from "../channelIds.ts";

const decodeOutbound = Schema.decodeUnknownSync(ChannelOutboundMessage);
export const ledgerOutboxDelivery = (causeKey: string, destination: unknown, taskId?: string) => ({
  deliveryId: deliveryIdFor(causeKey),
  causeKey,
  ...(taskId === undefined ? {} : { taskId: ChannelTaskId.make(taskId) }),
  message: decodeOutbound({
    deliveryId: deliveryIdFor(causeKey),
    destination,
    kind: "receipt",
    text: "On it.",
  }),
});

export const prepareDeliveryTask = Effect.fn("LedgerTest.prepareDeliveryTask")(function* (
  accepted: ChannelIngestResult,
  createdTask: NonNullable<
    Parameters<ChannelLedger.ChannelLedger["Service"]["completeReception"]>[0]["createdTask"]
  >,
  owner: string,
  now: string,
) {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const receptionId = ChannelReceptionId.make("test");
  yield* ledger.beginReception({ owner, inputId: accepted.inputId, receptionId, readAt: now });
  yield* ledger.completeReception({
    owner,
    inputId: accepted.inputId,
    receptionId,
    replyText: "On it.",
    decision: { replyText: "On it.", action: { type: "report_only" } },
    createdTask,
    deliveries: [],
    now,
  });
});
