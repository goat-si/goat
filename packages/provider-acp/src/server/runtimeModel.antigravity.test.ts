import { expect, it } from "vite-plus/test";
import { extractMcpToolCallIdentity, parseSessionUpdateEvent } from "./runtimeModel.ts";

it("recognizes Antigravity's GOAT MCP call titles", () => {
  for (const title of [
    "Run mcp_goat_delegate_task",
    "Run mcp_goat_delegate_task?",
    "Running delegate_task",
  ]) {
    const event = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call",
        kind: "other",
        title,
        status: "pending",
      },
    }).events.find((candidate) => candidate._tag === "ToolCallUpdated");
    expect(event?._tag === "ToolCallUpdated" && extractMcpToolCallIdentity(event.toolCall)).toEqual(
      { server: "goat", tool: "delegate_task" },
    );
  }
});
