import { describe, expect, it } from "vite-plus/test";

import { markdownWithAssistantInsights } from "./markdownAssistantInsights";

const rule = "─".repeat(45);

describe("markdownWithAssistantInsights", () => {
  it("shows a Claude insight block as a quote headed by its label", () => {
    const markdown = `Done.\n\n★ Insight ${rule}\n- one\n- **two**\n${rule}\n\nAfter.`;
    expect(markdownWithAssistantInsights(markdown)).toBe(
      "Done.\n\n> **★ Insight**\n> - one\n> - **two**\n\n\nAfter.",
    );
  });

  it("keeps an insight that is still streaming inside its quote", () => {
    expect(markdownWithAssistantInsights(`★ Insight ${rule}\r\nA note`)).toBe(
      "> **★ Insight**\r\n> A note",
    );
  });

  it("leaves an insight inside a code block as written", () => {
    const markdown = `\`\`\`\n★ Insight ${rule}\nnot a callout\n${rule}\n\`\`\``;
    expect(markdownWithAssistantInsights(markdown)).toBe(markdown);
  });
});
