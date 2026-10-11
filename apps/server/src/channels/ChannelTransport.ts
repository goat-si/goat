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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
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

const makeRegistry = Effect.gen(function* () {
  const transports = yield* Ref.make(new Map<ChannelKind, ChannelTransport>());
  return ChannelTransportRegistry.of({
    register: (transport) =>
      Effect.acquireRelease(
        Ref.update(transports, (current) => new Map(current).set(transport.kind, transport)),
        () =>
          Ref.update(transports, (current) => {
            if (current.get(transport.kind) !== transport) return current;
            const next = new Map(current);
            next.delete(transport.kind);
            return next;
          }),
      ),
    resolve: (kind) =>
      Ref.get(transports).pipe(Effect.map((current) => Option.fromNullishOr(current.get(kind)))),
  });
});

export const layer = Layer.effect(ChannelTransportRegistry, makeRegistry);
