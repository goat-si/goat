import * as Layer from "effect/Layer";

import { channelBotWorkMocks } from "./channels/testkit/channelBotWorkMocks.ts";
import { ThreadForkWorkspaceService } from "./orchestration-v2/goat/ThreadForkWorkspace.ts";

/** Empty services behind the handler modules ws.ts spreads, for tests that only assemble ws.ts. */
export const wsHandlerMocks = Layer.mergeAll(
  channelBotWorkMocks,
  Layer.mock(ThreadForkWorkspaceService)({}),
);
