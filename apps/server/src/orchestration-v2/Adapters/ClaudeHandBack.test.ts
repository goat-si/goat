import { expect, it } from "vite-plus/test";
import { claudeSubagentResultText, isClaudeSubagentAsyncLaunchAck } from "./ClaudeToolFrames.ts";

it("unwraps the hand-back report without mistaking it for an async acknowledgement", () => {
  const output = {
    type: "content_block" as const,
    value: [
      {
        type: "text" as const,
        text: "<tools-used-before-summary>Read</tools-used-before-summary>\n[Subagent hand-back] The text below is the final report of a subagent delegated here. The report follows:\n  Async agent launched successfully.\n  Done.\nagentId: a1 (use SendMessage with to: 'a1' to continue)\n<usage>tokens: 1</usage>",
      },
    ],
  };
  expect(claudeSubagentResultText(output)).toBe("Async agent launched successfully.\nDone.");
  expect(isClaudeSubagentAsyncLaunchAck(output)).toBe(false);
});
