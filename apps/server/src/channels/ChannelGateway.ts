/**
 * ChannelGateway - the one entry point for channel input and identity links.
 *
 * `ingest` waits only for durable storage of the input and returns a receipt; reception,
 * ledger changes, and replies run afterwards. Adapters acknowledge their transport after
 * `ingest` succeeds, so a failed store leaves the message for the transport to redeliver.
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
    /** Consumes a one-time link code. The code is never stored with message content. */
    readonly linkIdentity: (
      input: ChannelIdentityLinkConsumeInput,
      context: ChannelIngressContext,
    ) => Effect.Effect<ChannelIdentityLinkConsumeResult, ChannelGatewayError>;
    /** Hands one delivery to the registered transport for its destination. */
    readonly send: (
      message: ChannelOutboundMessage,
    ) => Effect.Effect<ChannelDeliveryReceipt, ChannelGatewayError>;
  }
>()("t3/channels/ChannelGateway") {}
