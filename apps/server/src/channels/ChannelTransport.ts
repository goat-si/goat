/**
 * ChannelTransport - the port a channel adapter implements to deliver outbound messages.
 *
 * Only the delivery worker sends. It resolves the adapter for a destination's kind from the
 * registry; adapters register for the lifetime of their scope, so a stopped adapter stops
 * receiving deliveries. Core code never imports a channel SDK.
 *
 * @module ChannelTransport
 */
import type {
  ChannelDeliveryReceipt,
  ChannelGatewayError,
  ChannelKind,
  ChannelOutboundMessage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

export interface ChannelTransport {
  readonly kind: ChannelKind;
  /**
   * Delivers one message. Delivery is at least once: a timeout does not prove the channel did
   * not receive it, so adapters return the external message id whenever they get one.
   */
  readonly send: (
    message: ChannelOutboundMessage,
  ) => Effect.Effect<ChannelDeliveryReceipt, ChannelGatewayError>;
}

export class ChannelTransportRegistry extends Context.Service<
  ChannelTransportRegistry,
  {
    /** Registers an adapter until the surrounding scope closes. One adapter per kind. */
    readonly register: (transport: ChannelTransport) => Effect.Effect<void, never, Scope.Scope>;
    readonly resolve: (kind: ChannelKind) => Effect.Effect<Option.Option<ChannelTransport>>;
  }
>()("t3/channels/ChannelTransport/ChannelTransportRegistry") {}
