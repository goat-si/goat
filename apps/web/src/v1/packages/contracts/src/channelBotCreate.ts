import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BotColor, BotId, BotProfile } from "./botProfile.ts";

/** A member bot with its own conversation. A retry with the same clientRequestId returns it. */
export const ChannelCreateBotInput = Schema.Struct({
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  templateId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  retryForBotId: Schema.optionalKey(BotId),
  name: BotProfile.fields.name,
  avatar: BotProfile.fields.avatar,
  purpose: BotProfile.fields.purpose,
  defaultModelSelection: BotProfile.fields.defaultModelSelection,
  /** Read by servers with `goatBotProfileColor`; absent leaves the bot neutral. */
  color: Schema.optionalKey(BotColor),
});
export type ChannelCreateBotInput = typeof ChannelCreateBotInput.Type;

export const ChannelBotResult = Schema.Struct({
  bot: BotProfile,
  templateAutomationPending: Schema.optional(Schema.Literal(true)),
});
export type ChannelBotResult = typeof ChannelBotResult.Type;
