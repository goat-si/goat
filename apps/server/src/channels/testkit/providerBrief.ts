import { MessageId, type ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { ThreadLaunchInput } from "../../orchestration-v2/ThreadLaunchService.ts";
import { readChannelProviderBrief } from "../channelProviderBrief.ts";

export const providerBrief = Effect.fn("channelTest.providerBrief")(function* (
  threadId: ThreadId,
  messageId: string,
) {
  return yield* readChannelProviderBrief(
    yield* SqlClient.SqlClient,
    threadId,
    MessageId.make(messageId),
  );
});

export const launchBrief = Effect.fn("channelTest.launchBrief")(function* (
  launch: ThreadLaunchInput | undefined,
) {
  const messageId = launch?.initialMessage?.messageId;
  if (launch?.threadId === undefined || messageId === undefined) return "";
  return (yield* providerBrief(launch.threadId, messageId)) ?? launch.initialMessage?.text ?? "";
});
