import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Wake from "./claudeWakeNotice.ts";
import { terminalStatusFromResult } from "./ClaudeResultFailure.ts";
import {
  claudeNativeToolOutputValue,
  claudeToolResultEntriesFromMessage,
  isClaudeSubagentAsyncLaunchAck,
  isClaudeToolResultError,
  type ClaudeToolResultContentBlock,
  type ClaudeNativeToolOutput,
} from "./ClaudeToolFrames.ts";
import { parseClaudeWorkflowRunHandles } from "./claudeWorkflowProgress.ts";

// A session-task lifecycle result: it can precede a wake's real turn and ends no turn.
export function isClaudeEmptyTaskNotificationSuccess(message: SDKMessage): boolean {
  return (
    Wake.isClaudeTaskNotificationOriginResult(message) &&
    message.subtype === "success" &&
    !message.is_error &&
    message.num_turns === 0 &&
    message.result.length === 0 &&
    terminalStatusFromResult(message) === "completed"
  );
}

// Background Agent launches ACK immediately and workflow launches return run handles; only task_notification settles those.
export function claudeToolResultSettlesSubagent(
  toolResult: ClaudeToolResultContentBlock,
  output: ClaudeNativeToolOutput,
): boolean {
  return (
    isClaudeToolResultError(toolResult) ||
    (parseClaudeWorkflowRunHandles(claudeNativeToolOutputValue(output)) === undefined &&
      !isClaudeSubagentAsyncLaunchAck(output))
  );
}

export function claudeSettledSubagentToolUseIds(
  messages: ReadonlyArray<SDKMessage>,
): ReadonlySet<string> {
  return new Set(
    messages.flatMap((entry) =>
      entry.type === "user" && entry.parent_tool_use_id == null
        ? claudeToolResultEntriesFromMessage(entry).flatMap(({ toolResult, output }) =>
            claudeToolResultSettlesSubagent(toolResult, output) ? [toolResult.tool_use_id] : [],
          )
        : [],
    ),
  );
}
