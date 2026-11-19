import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export function isClaudePromptEchoGatedFrame(message: SDKMessage): boolean {
  switch (message.type) {
    case "assistant":
    case "stream_event":
    case "user":
      return message.parent_tool_use_id === null;
    case "result":
      return true;
    default:
      return false;
  }
}

export function claudeFrameToolUseIds(message: SDKMessage): ReadonlyArray<string> {
  const ids: Array<string> = [];
  const parent = Reflect.get(message, "parent_tool_use_id");
  if (typeof parent === "string") {
    ids.push(parent);
  }
  if (message.type === "system") {
    const toolUseId = Reflect.get(message, "tool_use_id");
    if (typeof toolUseId === "string") {
      ids.push(toolUseId);
    }
  }
  return ids;
}
