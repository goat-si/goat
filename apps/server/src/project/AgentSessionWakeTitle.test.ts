import { ProviderInstanceId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { parseAgentSessionTranscript } from "./AgentSessionTranscriptParser.ts";

it("titles an imported Claude session from the prompt inside a wake envelope", () => {
  const thread = parseAgentSessionTranscript({
    contents: JSON.stringify({
      type: "user",
      sessionId: "claude-session",
      timestamp: "2026-08-25T08:00:00.000Z",
      message: {
        role: "user",
        content:
          '<wake reason="mention" current-time="2026-08-25T08:00:00Z">\nFix the flaky login test\n</wake>',
      },
    }),
    source: "claudeAgent",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    fallbackSessionId: "fallback",
    lastActiveAtMs: Date.parse("2026-08-25T08:00:00.000Z"),
  });
  expect(thread?.title).toBe("Fix the flaky login test");
});
