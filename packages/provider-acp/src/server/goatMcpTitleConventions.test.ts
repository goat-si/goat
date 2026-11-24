import { describe, expect, it } from "vite-plus/test";

import { extractMcpToolCallIdentity, parseSessionUpdateEvent } from "./runtimeModel.ts";

const toolCallFromUpdate = (update: Parameters<typeof parseSessionUpdateEvent>[0]["update"]) => {
  const event = parseSessionUpdateEvent({ sessionId: "session-1", update }).events.find(
    (candidate) => candidate._tag === "ToolCallUpdated",
  );
  if (event?._tag !== "ToolCallUpdated") throw new Error("expected a tool call event");
  return event.toolCall;
};

describe("extractMcpToolCallIdentity for Antigravity", () => {
  // regression: Antigravity 1.5 titles every MCP call "Run mcp_<server>_<tool>", so GOAT calls
  // reached the timeline as "Run mcp_goat_goat_call" with no tool or path.
  it("recovers GOAT identity from Antigravity's Run mcp_goat_<tool> titles", () => {
    for (const [title, tool] of [
      ["Run mcp_goat_goat_call", "goat_call"],
      ["Running mcp_goat_goat_describe", "goat_describe"],
      ["Run mcp_goat_goat_thread_send?", "goat_thread_send"],
      ["Ran mcp_goat_delegate_task", "delegate_task"],
    ] as const) {
      const toolCall = toolCallFromUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "antigravity-mcp",
        kind: "other",
        title,
        status: "pending",
        rawInput: { path: "thread.read", args: { threadId: "t1" }, toolSummary: "Read thread" },
      });
      expect(extractMcpToolCallIdentity(toolCall), title).toEqual({ server: "goat", tool });
    }
    for (const title of ["Run mcp_goat_not_a_tool", "Run mcp_github_goat_call"]) {
      const toolCall = toolCallFromUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "antigravity-other",
        kind: "other",
        title,
        status: "pending",
      });
      expect(extractMcpToolCallIdentity(toolCall), title).toBeUndefined();
    }
  });
});
