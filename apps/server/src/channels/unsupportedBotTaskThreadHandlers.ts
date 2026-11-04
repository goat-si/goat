import { CHANNEL_GATEWAY_WS_METHODS, ChannelGatewayError } from "@goat/contracts";
import * as Effect from "effect/Effect";

export const unsupportedBotTaskThreadHandlers = {
  [CHANNEL_GATEWAY_WS_METHODS.listBotThreads]: () =>
    Effect.fail(new ChannelGatewayError({ reason: "adapter_unavailable" })),
  [CHANNEL_GATEWAY_WS_METHODS.updateTaskView]: () =>
    Effect.fail(new ChannelGatewayError({ reason: "adapter_unavailable" })),
};
