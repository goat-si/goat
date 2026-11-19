import type { OrchestrationV2ProviderTurn } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type { OrchestrationV2ExecutionNode, OrchestrationV2TurnItem } from "@goat/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";

export function codexUserMessageText(
  content: ReadonlyArray<CodexSchema.V2ItemCompletedNotification__UserInput>,
): string {
  return content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n")
    .trim();
}

export function codexItemStatus(status: "inProgress" | "completed" | "failed" | "declined"): {
  readonly node: OrchestrationV2ExecutionNode["status"];
  readonly turnItem: OrchestrationV2TurnItem["status"];
  readonly completed: boolean;
} {
  switch (status) {
    case "inProgress":
      return { node: "running", turnItem: "running", completed: false };
    case "completed":
      return {
        node: "completed",
        turnItem: "completed",
        completed: true,
      };
    case "failed":
      return { node: "failed", turnItem: "failed", completed: true };
    case "declined":
      return {
        node: "cancelled",
        turnItem: "cancelled",
        completed: true,
      };
  }
}

export function providerTurnStatusToTerminal(
  status: OrchestrationV2ProviderTurn["status"],
): Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "pending":
    case "running":
      return "failed";
  }
}
