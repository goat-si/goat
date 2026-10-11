/**
 * ChannelGateway - the one entry point for channel input and identity links.
 *
 * `ingest` waits only for durable storage of the input and returns a receipt; reception,
 * ledger changes, and replies run afterwards. Input from an unlinked account returns
 * `state: "rejected"` with a link notice already committed.
 *
 * Acknowledging the transport: when a call fails with reason `persistence_failed`, adapters
 * do not acknowledge, so the transport redelivers. Every other result or error means any
 * notice was already committed, so adapters acknowledge. Adapters never send replies
 * themselves; the delivery worker does.
 *
 * @module ChannelGateway
 */
import type {
  ChannelDeliveryReceipt,
  ChannelGatewayError,
  ChannelIdentityLinkConsumeInput,
  ChannelIdentityLinkConsumeResult,
  ChannelIngestInput,
  ChannelIngestResult,
  ChannelNoticeInput,
  ChannelNoticeReceipt,
  ChannelOutboundMessage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ChannelIngressContext } from "./ChannelIngressContext.ts";

export class ChannelGateway extends Context.Service<
  ChannelGateway,
  {
    readonly ingest: (
      input: ChannelIngestInput,
      context: ChannelIngressContext,
    ) => Effect.Effect<ChannelIngestResult, ChannelGatewayError>;
    /**
     * Consumes a one-time link code and commits a success or failure notice to the input's reply
     * address. The code is never stored with message content.
     */
    readonly linkIdentity: (
      input: ChannelIdentityLinkConsumeInput,
      context: ChannelIngressContext,
    ) => Effect.Effect<ChannelIdentityLinkConsumeResult, ChannelGatewayError>;
    /** Commits a fixed notice, such as link help, for delivery to the reply address. */
    readonly requestNotice: (
      input: ChannelNoticeInput,
      context: ChannelIngressContext,
    ) => Effect.Effect<ChannelNoticeReceipt, ChannelGatewayError>;
    /** Hands one delivery to the registered transport for its destination. */
    readonly send: (
      message: ChannelOutboundMessage,
    ) => Effect.Effect<ChannelDeliveryReceipt, ChannelGatewayError>;
  }
>()("t3/channels/ChannelGateway") {}
