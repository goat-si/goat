import type { OrchestrationV2TurnItem } from "@goat/contracts";
import { classifyToolActivity, isJavaScriptReplTool } from "@goat/shared/toolActivity";

export type ThreadActivityIcon =
  | "agent"
  | "alert"
  | "browser"
  | "computer"
  | "code"
  | "check"
  | "command"
  | "edit"
  | "eye"
  | "folder"
  | "globe"
  | "search"
  | "stop"
  | "hammer"
  | "lock"
  | "message"
  | "warning"
  | "wrench"
  | "zap";

export function itemIcon(item: OrchestrationV2TurnItem): ThreadActivityIcon {
  if (item.type === "system_notice" && item.severity === "info") return "eye";
  if (item.type === "notification") {
    const source = item.source;
    switch (source.kind) {
      case "subagent":
      case "delegated_task":
        return "hammer";
      case "command":
        return "command";
      case "monitor":
        return "eye";
      case "question":
        return "message";
      case "background_task":
      case "system":
        return "zap";
      default:
        source satisfies never;
        return "zap";
    }
  }
  if (item.type === "dynamic_tool") {
    const classified = classifyToolActivity({
      itemType: "dynamic_tool_call",
      data: { toolName: item.toolName ?? undefined, input: item.input },
    });
    if (classified === "read") {
      return "eye";
    }
    if (classified === "search") return "search";
  }
  if (item.type === "command_execution" && item.commandActions?.length) {
    const kinds = new Set(item.commandActions.map((action) => action.type));
    if (kinds.size === 1 && kinds.has("read")) return "eye";
    if (kinds.size === 1 && kinds.has("list")) return "folder";
    return "search";
  }
  switch (item.type) {
    case "reasoning":
      return "agent";
    case "command_execution":
      return "command";
    case "file_change":
      return "edit";
    case "file_search":
      return "search";
    case "web_search":
      return "globe";
    case "approval_request":
      return item.requestKind === "permission" ? "lock" : "message";
    case "user_input_request":
    case "user_message":
    case "assistant_message":
      return "message";
    case "dynamic_tool":
      return isJavaScriptReplTool(item.toolName) ? "code" : "wrench";
    case "subagent":
      return "hammer";
    case "run_interrupt_request":
    case "run_interrupt_result":
      return "stop";
    case "system_notice":
      return "warning";
    case "error":
      return item.failure.class === "usage_limit"
        ? item.status === "completed"
          ? "check"
          : "warning"
        : "alert";
    case "checkpoint":
    case "proposed_plan":
    case "todo_list":
      return "check";
    case "compaction":
    case "handoff":
    case "fork":
    case "thread_created":
      return "zap";
    case "human_handoff":
    case "secret_request":
      return "lock";
  }
}
