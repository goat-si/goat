import type {
  WorkLogPresentationEntry,
  WorkLogToolLifecycleStatus,
} from "@goat/client-runtime/work-log/presentation";
import type { OrchestrationV2TurnItem } from "@goat/contracts";

export function itemLifecycleStatus(item: OrchestrationV2TurnItem): WorkLogToolLifecycleStatus {
  switch (item.status) {
    case "pending":
    case "running":
    case "waiting":
      return "inProgress";
    case "idle":
      return "idle";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

export function itemWorkLogTone(item: OrchestrationV2TurnItem): WorkLogPresentationEntry["tone"] {
  if (item.type === "error") return "info";
  if (item.type === "reasoning") return "thinking";
  switch (item.type) {
    case "command_execution":
    case "file_change":
    case "file_search":
    case "web_search":
    case "dynamic_tool":
    case "subagent":
      return "tool";
    default:
      return "info";
  }
}
