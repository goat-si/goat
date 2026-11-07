import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import * as ChannelBotArtifacts from "./ChannelBotArtifacts.ts";
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
    // Built once per connection, so this permit lets each connection read one chunk at a time.
    ...ChannelBotArtifacts.rpcHandlers(
      yield* ChannelBotArtifacts.ChannelBotArtifacts,
      yield* Semaphore.make(1),
    ),
  };
});
