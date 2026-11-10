import { describe, expect, it } from "vite-plus/test";

import { goatBotReplyParts } from "./replyParts.ts";

const table = ["| Plan | Price |", "| --- | ---: |", "| Basic | $5 |", "| Pro | $20 |"].join("\n");

describe("goatBotReplyParts", () => {
  it("splits an answer into its opening text, the table and the closing text", () => {
    expect(goatBotReplyParts(`Here are the plans:\n\n${table}\n\nPro adds sync.`)).toEqual([
      { kind: "text", text: "Here are the plans:" },
      { kind: "table", text: table },
      { kind: "text", text: "Pro adds sync." },
    ]);
  });

  it("gives each of two tables its own part", () => {
    const other = "a | b\n-|-\n1 | 2";
    expect(goatBotReplyParts(`${table}\n\nAnd:\n${other}`).map((part) => part.kind)).toEqual([
      "table",
      "text",
      "table",
    ]);
  });

  it("leaves a table inside a code fence in its text", () => {
    const text = `Example:\n\n\`\`\`md\n${table}\n\`\`\`\nDone.`;
    expect(goatBotReplyParts(text)).toEqual([{ kind: "text", text }]);
  });

  it("keeps an answer without a table whole, and pipes without a separator are text", () => {
    const text = "Run `a | b` then\n| not | a table |";
    expect(goatBotReplyParts(text)).toEqual([{ kind: "text", text }]);
  });
});
