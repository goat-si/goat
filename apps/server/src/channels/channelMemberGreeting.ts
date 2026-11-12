import type { BotProfile, ChannelMessageMeta, ThreadId } from "@goat/contracts";
import type * as Effect from "effect/Effect";

import type * as ChannelBotTimeline from "./ChannelBotTimeline.ts";
import { conversationIdFor, goatConversationKeyFor, greetingRecordKeyFor } from "./channelIds.ts";
import { GOAT_CONNECTION_ID } from "./ChannelGateway.ts";

const PURPOSE_SHOWN = 300;

/** What a new member says first, from its own name and purpose; no model is asked. */
function memberGreetingText(bot: Pick<BotProfile, "name" | "purpose">): string {
  const purpose = bot.purpose.trim();
  const shown = purpose.length > PURPOSE_SHOWN ? purpose.slice(0, PURPOSE_SHOWN) + "…" : purpose;
  return purpose === ""
    ? `Hi, I'm ${bot.name}. What would you like me to start with?`
    : `Hi, I'm ${bot.name}. You set me up for: ${shown}\n\nWhat would you like me to start with?`;
}

/**
 * Records the greeting in the member's own chat; only the person reads it, never the bot's
 * session. One record key per bot, so a retry or a later re-record updates the same message.
 */
export const recordMemberGreeting = <A, E>(
  record: (input: ChannelBotTimeline.TimelineRecordInput) => Effect.Effect<A, E>,
  input: {
    readonly ownerId: string;
    readonly threadId: ThreadId;
    readonly bot: Pick<BotProfile, "botId" | "name" | "purpose">;
    /** The revision for this greeting's text; a new revision is a new command. */
    readonly revision: (text: string) => string;
  },
) => {
  const meta: ChannelMessageMeta = {
    conversationId: conversationIdFor({
      ownerId: input.ownerId,
      kind: "goat",
      connectionId: GOAT_CONNECTION_ID,
      conversationKey: goatConversationKeyFor(input.bot.botId),
    }),
    originKind: "goat",
    kind: "receipt",
  };
  const text = memberGreetingText(input.bot);
  return record({
    threadId: input.threadId,
    record: {
      recordKey: greetingRecordKeyFor(input.bot.botId),
      entry: { type: "message", role: "assistant", text, meta },
    },
    revision: input.revision(text),
  });
};
