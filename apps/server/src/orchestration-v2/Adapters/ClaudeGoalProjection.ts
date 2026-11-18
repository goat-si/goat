import type { SDKAssistantMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { OrchestrationV2ProviderGoal } from "@goat/contracts";
import * as Schema from "effect/Schema";

export function textFromClaudeContent(content: SDKAssistantMessage["message"]["content"]): string {
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

// In SDK mode, /goal appears only in transcripts: command output names it and Stop hooks report unmet checks.
const CLAUDE_GOAL_SET_PREFIX = "Goal set: ";
const CLAUDE_GOAL_ACTIVE = /^Goal active: ([\s\S]+?) \((?:not yet evaluated|(\d+) turns?)\)/u;

export function nextClaudeGoal(
  current: OrchestrationV2ProviderGoal | null,
  message: SDKMessage,
): OrchestrationV2ProviderGoal | null | undefined {
  if (message.type === "assistant") {
    if (message.parent_tool_use_id !== null || message.message.model !== "<synthetic>") {
      return undefined;
    }
    const text = textFromClaudeContent(message.message.content).trim();
    if (text.startsWith(CLAUDE_GOAL_SET_PREFIX)) {
      const objective = text.slice(CLAUDE_GOAL_SET_PREFIX.length).trim();
      return objective.length === 0 ? undefined : { objective, status: "active", checks: 0 };
    }
    if (text.startsWith("Goal cleared: ") || text.startsWith("No goal set")) return null;
    const active = CLAUDE_GOAL_ACTIVE.exec(text);
    if (active?.[1] === undefined) return undefined;
    return {
      ...(current?.objective === active[1] ? current : {}),
      objective: active[1],
      status: "active",
      checks: Number(active[2] ?? 0),
    };
  }
  if (
    message.type !== "user" ||
    message.parent_tool_use_id !== null ||
    message.isSynthetic !== true ||
    current === null
  ) {
    return undefined;
  }
  const prefix = `Stop hook feedback:\n[${current.objective}]: `;
  const content = message.message.content;
  const text =
    typeof content === "string"
      ? content
      : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  if (!text.startsWith(prefix)) return undefined;
  return {
    ...current,
    status: "active",
    checks: (current.checks ?? 0) + 1,
    lastCheck: text.slice(prefix.length).trim(),
  };
}

/** The CLI confirms a goal change as a synthetic reply; the goal row shows that change instead. */
export function isClaudeGoalAcknowledgement(message: SDKMessage): boolean {
  if (
    message.type !== "assistant" ||
    message.parent_tool_use_id !== null ||
    message.message.model !== "<synthetic>"
  ) {
    return false;
  }
  const text = textFromClaudeContent(message.message.content).trim();
  return text.startsWith(CLAUDE_GOAL_SET_PREFIX) || text.startsWith("Goal cleared: ");
}

export const providerGoalsEqual = Schema.toEquivalence(Schema.NullOr(OrchestrationV2ProviderGoal));
