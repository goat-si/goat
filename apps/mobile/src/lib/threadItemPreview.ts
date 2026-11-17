import { providerErrorPresentation } from "@goat/client-runtime/work-log/provider-error";
import type { OrchestrationV2TurnItem } from "@goat/contracts";

export function itemPreview(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "reasoning":
      return item.text || null;
    case "command_execution":
      return item.input || null;
    case "file_change":
      return item.fileName;
    case "file_search":
      return item.pattern ?? null;
    case "web_search":
      return item.patterns?.join(", ") ?? null;
    case "approval_request":
      return item.prompt ?? null;
    case "user_input_request":
      return item.questions.map((question) => question.question).join(" · ") || null;
    case "checkpoint":
      return item.files.length === 1
        ? (item.files[0]?.path ?? null)
        : `${item.files.length} changed files`;
    case "run_interrupt_request":
    case "run_interrupt_result":
      return item.message || null;
    case "system_notice":
      return item.message.split("\n").slice(1).join("\n").trim() || null;
    case "error":
      return providerErrorPresentation(item).detail;
    case "compaction":
    case "handoff":
      return item.summary ?? null;
    case "fork":
    case "thread_created":
      return item.targetThreadId;
    case "human_handoff":
      return item.handoff.reason;
    case "secret_request":
      return item.reason || null;
    case "subagent":
      return item.result ?? item.progress ?? item.prompt;
    case "dynamic_tool":
      return null;
    case "notification":
      return item.detail ?? null;
    case "proposed_plan":
      return item.markdown || null;
    case "todo_list":
      return `${item.steps.filter((step) => step.status === "completed").length}/${item.steps.length} completed`;
    case "user_message":
    case "assistant_message":
      return item.text || null;
  }
}
