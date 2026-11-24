import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { summarizeClaudeToolRequest, claudeWebFetchSnippet } from "./ClaudeToolFrames.ts";
import { providerFailureFromResult } from "./ClaudeResultFailure.ts";

it("keeps truncated tool requests, API errors and web snippets valid Unicode", () => {
  const command = "a".repeat(399) + "😀";
  assert.equal(
    summarizeClaudeToolRequest("Bash", { type: "record", value: { command } }),
    `Bash: ${"a".repeat(399)}`,
  );
  assert.equal(claudeWebFetchSnippet("a".repeat(7999) + "😀"), "a".repeat(7999));
  const result = {
    subtype: "success",
    is_error: true,
    terminal_reason: "api_error",
    result: "API Error: " + "a".repeat(488) + "😀",
  } as unknown as SDKResultMessage;
  const message = providerFailureFromResult(result, DateTime.makeUnsafe(0))?.message;
  assert.isTrue(message?.isWellFormed());
});
