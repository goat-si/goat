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

export function answersClaudeRequest(message: SDKMessage, promptUuid: string | null): boolean {
  const lifecycle = claudePromptLifecycle(message);
  if (lifecycle !== null) return lifecycle.uuid === promptUuid && lifecycle.state !== "started";
  if (Reflect.get(message, "parent_tool_use_id") != null) return false;
  if (message.type === "system") {
    return message.subtype === "task_started" && (message.spawn_depth ?? 1) <= 1;
  }
  if (
    message.type !== "assistant" &&
    message.type !== "stream_event" &&
    message.type !== "user" &&
    message.type !== "result"
  )
    return false;
  const echoed = claudeEchoedPromptUuids(message);
  if (echoed.length > 0) return promptUuid !== null && echoed.includes(promptUuid);
  if (message.type === "user" && typeof message.message.content === "string") {
    return message.uuid === undefined || message.uuid === promptUuid;
  }
  return true;
}
