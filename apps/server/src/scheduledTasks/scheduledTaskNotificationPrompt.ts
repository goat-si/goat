import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ScheduledTaskError,
  type ScheduledTask,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

export const prepareScheduledTaskNotificationPrompt = Effect.fn(
  "ScheduledTaskNotificationPrompt.prepare",
)(function* (task: ScheduledTask, expandedPrompt?: string) {
  const instruction =
    task.threadId !== null && task.notificationPolicy === "important_updates"
      ? "\n\nAt the start of your work, capture thread.status run.runId and run.activeAttemptId for your own active attempt. Retain that pair with the result. Before ending a successful check with nothing new or actionable, use goat_call thread.report_result with that runId, expectedAttemptId, outcome succeeded and notificationRelevance no_update. Use important for a meaningful update. Do not refresh identity at reporting time or reuse another attempt's identity. If the initial pair is unavailable or uncertain, do not report no_update. Never report a failure as no_update."
      : "";
  const prompt = (expandedPrompt ?? task.prompt) + instruction;
  if (prompt.trim().length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS)
    return yield* new ScheduledTaskError({
      message: "The scheduled task prompt exceeds the provider input limit.",
      taskId: task.id,
    });
  return prompt;
});
