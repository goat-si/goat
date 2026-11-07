import * as Layer from "effect/Layer";

import * as ChannelBotNotesReader from "../ChannelBotNotesReader.ts";
import * as ChannelBotThreads from "../ChannelBotThreads.ts";

/** Empty services behind channelBotWorkRpcHandlers, for tests that only assemble ws.ts. */
export const channelBotWorkMocks = Layer.mergeAll(
  Layer.mock(ChannelBotThreads.ChannelBotThreads)({}),
  Layer.mock(ChannelBotNotesReader.ChannelBotNotesReader)({}),
);
