import { describe, expect, it } from "vite-plus/test";

import {
  formatSlackOutboundMessages,
  SLACK_MAX_MESSAGES,
  SLACK_TEXT_LIMIT,
  SLACK_TRUNCATED_NOTE,
  stripBotMention,
  toSlackMrkdwn,
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

describe("toSlackMrkdwn", () => {
  it("converts the Markdown models write", () => {
    expect(toSlackMrkdwn("## Result\n**bold**, __also__, ~~gone~~, ***both***")).toBe(
      "*Result*\n*bold*, *also*, ~gone~, *_both_*",
    );
    expect(toSlackMrkdwn("see [PR [1]](https://github.com/a/b/pull/1)")).toBe(
      "see <https://github.com/a/b/pull/1|PR [1]>",
    );
  });

  it("leaves code alone and drops fence language tags", () => {
    expect(toSlackMrkdwn("`**x**` and\n```ts\nconst a = **b**;\n```")).toBe(
      "`**x**` and\n```\nconst a = **b**;\n```",
    );
  });

  it("links only http(s) URLs and keeps a pipe from ending the URL", () => {
    expect(toSlackMrkdwn("[x](javascript:alert)")).toBe("[x](javascript:alert)");
    expect(toSlackMrkdwn("[x](https://a.io/?q=a|b)")).toBe("<https://a.io/?q=a%7Cb|x>");
  });
});

describe("formatSlackOutboundMessages", () => {
  it("mentions the requester before the escaped text", () => {
    expect(
      formatSlackOutboundMessages({ text: "done: a < b & c", mentionUserId: "U0ALICE" }),
    ).toEqual(["<@U0ALICE> done: a &lt; b &amp; c"]);
  });

  it("neutralizes broadcast and fake mentions written by the model", () => {
    expect(formatSlackOutboundMessages({ text: "<!channel> ping <@U0EVE>" })).toEqual([
      "&lt;!channel&gt; ping &lt;@U0EVE&gt;",
    ]);
    // A Markdown link cannot smuggle one in either.
    expect(formatSlackOutboundMessages({ text: "[<!here>](https://a.io)" })).toEqual([
      "<https://a.io|&lt;!here&gt;>",
    ]);
  });

  it("does not mention an ID that is not a Slack user ID", () => {
    expect(formatSlackOutboundMessages({ text: "hi", mentionUserId: "<!here>" })).toEqual(["hi"]);
  });

  it("splits a long reply into messages that keep all of it", () => {
    const lines = Array.from({ length: 400 }, (_, index) => "line " + index + " 결과 확인 🐐");
    const messages = formatSlackOutboundMessages({
      text: lines.join("\n"),
      mentionUserId: "U0ALICE",
    });
    expect(messages.length).toBeGreaterThan(1);
    expect(messages[0]!.startsWith("<@U0ALICE> line 0 ")).toBe(true);
    expect(messages.slice(1).some((message) => message.includes("U0ALICE"))).toBe(false);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(SLACK_TEXT_LIMIT);
    const joined = messages.join("\n").replace("<@U0ALICE> ", "");
    expect(joined.split("\n")).toEqual(lines);
  });

  it("keeps a split code block closed in every message", () => {
    const code = Array.from({ length: 300 }, (_, index) => "const v" + index + " = a < b;").join(
      "\n",
    );
    const messages = formatSlackOutboundMessages({ text: "Patch:\n```ts\n" + code + "\n```" });
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect((message.match(/^```/gm) ?? []).length % 2).toBe(0);
      expect(message.length).toBeLessThanOrEqual(SLACK_TEXT_LIMIT);
    }
    const body = messages
      .join("\n")
      .split("\n")
      .filter((line) => line.startsWith("const "));
    expect(body).toEqual(code.replaceAll("<", "&lt;").split("\n"));
  });

  it("fits text whose escaping grows it past the limit", () => {
    const messages = formatSlackOutboundMessages({ text: "&".repeat(5000) });
    const joined = messages.join("");
    expect(joined.length).toBe("&amp;".length * 5000);
    expect(joined.replaceAll("&amp;", "")).toBe("");
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(SLACK_TEXT_LIMIT);
  });

  it("ends a reply past the message cap with a note", () => {
    const messages = formatSlackOutboundMessages({
      text: Array.from({ length: 20_000 }, () => "word").join("\n"),
    });
    expect(messages.length).toBe(SLACK_MAX_MESSAGES);
    expect(messages.at(-1)).toBe(SLACK_TRUNCATED_NOTE);
  });
});
