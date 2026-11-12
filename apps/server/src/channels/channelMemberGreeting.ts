import type { BotProfile, ChannelMessageMeta, ThreadId } from "@goat/contracts";
import { isGeneratedBotName } from "@goat/shared/goatBotNames";
import * as Effect from "effect/Effect";

import type * as ChannelBotTimeline from "./ChannelBotTimeline.ts";
import { conversationIdFor, goatConversationKeyFor } from "./channelIds.ts";
import { GOAT_CONNECTION_ID } from "./ChannelGateway.ts";

const PURPOSE_SHOWN = 300;

/** What a new member says first, from its own name and purpose; no model is asked. */
function memberGreetingText(bot: Pick<BotProfile, "name" | "purpose">): string {
  const purpose = bot.purpose.trim();
  const shown = purpose.length > PURPOSE_SHOWN ? purpose.slice(0, PURPOSE_SHOWN) + "…" : purpose;
  // A generated name is not the person's choice, so the greeting waits for the real one.
  if (isGeneratedBotName(bot.name)) {
    return purpose === ""
      ? "Hi, I'm your new bot. Give me a name, or tell me what you'd like me to start with."
      : `Hi, I'm your new bot. You set me up for: ${shown}\n\nGive me a name, or tell me what you'd like me to start with.`;
  }
  return purpose === ""
    ? `Hi, I'm ${bot.name}. What would you like me to start with?`
    : `Hi, I'm ${bot.name}. You set me up for: ${shown}\n\nWhat would you like me to start with?`;
}

/**
 * Records the greeting in the member's own chat. The record key makes a retried creation write
 * it once; the bot's session later reads it as its own first reply.
 */
export const recordMemberGreeting = (
  record: ChannelBotTimeline.ChannelBotTimeline["Service"]["record"],
  input: {
    readonly ownerId: string;
    readonly threadId: ThreadId;
    readonly bot: Pick<BotProfile, "botId" | "name" | "purpose">;
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
  return record({
    threadId: input.threadId,
    record: {
      recordKey: "greeting:" + input.bot.botId,
      entry: { type: "message", role: "assistant", text: memberGreetingText(input.bot), meta },
    },
    revision: "v1",
  }).pipe(Effect.asVoid);
};
