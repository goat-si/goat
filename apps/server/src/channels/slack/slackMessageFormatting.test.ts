import { describe, expect, it } from "vite-plus/test";

import {
  formatSlackOutboundText,
  SLACK_TEXT_LIMIT,
  stripBotMention,
} from "./slackMessageFormatting.ts";

describe("stripBotMention", () => {
  it("removes only this bot's mention, with or without a label", () => {
    expect(stripBotMention("<@U0BOT> ask <@U0ALICE> about it", "U0BOT")).toBe(
      "ask <@U0ALICE> about it",
    );
    expect(stripBotMention("hey <@U0BOT|goat>  please   look", "U0BOT")).toBe("hey please look");
  });

  it("keeps line breaks in multi-line requests", () => {
    expect(stripBotMention("<@U0BOT> first\n  second", "U0BOT")).toBe("first\nsecond");
  });
});

describe("formatSlackOutboundText", () => {
  it("mentions the requester before the escaped text", () => {
    expect(formatSlackOutboundText({ text: "done: a < b & c", mentionUserId: "U0ALICE" })).toBe(
      "<@U0ALICE> done: a &lt; b &amp; c",
    );
  });

  it("neutralizes broadcast and fake mentions written by the model", () => {
    const text = formatSlackOutboundText({ text: "<!channel> ping <@U0EVE>" });
    expect(text).toBe("&lt;!channel&gt; ping &lt;@U0EVE&gt;");
  });

  it("does not mention an ID that is not a Slack user ID", () => {
    expect(formatSlackOutboundText({ text: "hi", mentionUserId: "<!here>" })).toBe("hi");
  });

  it("keeps long text within Slack's limit without cutting an escape in half", () => {
    const text = formatSlackOutboundText({
      text: `${"a".repeat(SLACK_TEXT_LIMIT - 11)}&&&&&&&&&&`,
      mentionUserId: "U0ALICE",
    });
    expect(text.length).toBeLessThanOrEqual(SLACK_TEXT_LIMIT);
    expect(text.endsWith("…")).toBe(true);
    expect(text).not.toMatch(/&[a-z]{0,3}…$/);
  });
});
