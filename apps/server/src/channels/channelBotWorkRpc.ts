import * as Effect from "effect/Effect";

import * as ChannelBotNotesReader from "./ChannelBotNotesReader.ts";
import * as ChannelBotThreads from "./ChannelBotThreads.ts";
import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";

/** The read handlers behind GOAT Bot's Work panel tabs, kept together so ws.ts needs one line. */
export const channelBotWorkRpcHandlers = Effect.fn("channel.botWorkRpcHandlers")(function* (
  owner: ChannelConnectionOwner,
) {
  return {
    ...ChannelBotThreads.rpcHandlers(yield* ChannelBotThreads.ChannelBotThreads, owner),
    ...ChannelBotNotesReader.rpcHandlers(yield* ChannelBotNotesReader.ChannelBotNotesReader),
  };
});
