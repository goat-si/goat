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

export function claudeEchoedPromptUuids(message: SDKMessage): ReadonlyArray<string> {
  const uuids = Reflect.get(message, "user_message_uuids");
  if (Array.isArray(uuids)) {
    return uuids.filter((uuid): uuid is string => typeof uuid === "string");
  }
  const uuid = Reflect.get(message, "user_message_uuid");
  return typeof uuid === "string" ? [uuid] : [];
}

export function claudePromptLifecycle(
  message: SDKMessage,
): { readonly uuid: string; readonly state: string } | null {
  const type: unknown = Reflect.get(message, "type");
  if (type !== "command_lifecycle") return null;
  const uuid: unknown = Reflect.get(message, "command_uuid");
  const state: unknown = Reflect.get(message, "state");
  return typeof uuid === "string" && typeof state === "string" ? { uuid, state } : null;
}

// Without an echo, non-human origin proves a foreign turn only on CLIs known to echo prompts.
