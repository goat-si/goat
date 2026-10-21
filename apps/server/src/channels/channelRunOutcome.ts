/**
 * How a channel task settles once its worker's current run ended `completed`. The run's status
 * stays necessary; the outcome the worker reported with goat_thread_report_result decides what
 * the requester sees. Local and remote workers settle through this one rule.
 *
 * @module channelRunOutcome
 */
import type { ChannelTask, RunId, ThreadResultOutcome } from "@goat/contracts";

import { questionIdFor } from "./channelIds.ts";
import type { ChannelTaskEventSpec } from "./channelTaskWrites.ts";

export interface ReportedRunOutcome {
  readonly outcome: ThreadResultOutcome;
  readonly summary?: string | undefined;
}

const REPORTED_FAILED_FALLBACK = "The worker reported that it could not finish.";
const REPORTED_CANCELLED_FALLBACK = "The worker reported that it stopped before finishing.";
const REPORTED_BLOCKED_FALLBACK =
  "The worker reported that it is blocked without giving a reason. How should it continue?";

/**
 * The event that settles `task` after run `runId` completed. `fallbackSummary` is what the task
 * said before reports existed (the last assistant message, a proposed completion, "Finished.").
 */
export const settleCompletedRun = (input: {
  readonly task: ChannelTask;
  readonly runId: RunId;
  readonly reported: ReportedRunOutcome | undefined;
  readonly fallbackSummary: string;
  readonly now: string;
}): ChannelTaskEventSpec => {
  const { task, runId, reported } = input;
  const summary = reported?.summary?.trim() || undefined;
  switch (reported?.outcome) {
    case "failed":
      return {
        type: "task.failed",
        payload: {
          generation: task.generation,
          reason: "reported_outcome",
          summary: summary ?? REPORTED_FAILED_FALLBACK,
        },
      };
    case "cancelled":
      // task.cancelled stays for a person's cancellation.
      return {
        type: "task.failed",
        payload: {
          generation: task.generation,
          reason: "reported_cancelled",
          summary: summary ?? REPORTED_CANCELLED_FALLBACK,
        },
      };
    case "blocked":
      // A question resumes the worker through the existing answer path.
      return {
        type: "task.question.opened",
        payload: {
          question: {
            questionId: questionIdFor(task.taskId, task.version + 1),
            text: summary ?? REPORTED_BLOCKED_FALLBACK,
            askedAt: input.now,
            ...(task.requester.externalActorId === undefined
              ? {}
              : { requesterExternalActorId: task.requester.externalActorId }),
          },
        },
      };
    case "succeeded":
    case undefined:
      return {
        type: "task.completed",
        payload: {
          generation: task.generation,
          runId,
          summary: summary ?? input.fallbackSummary,
          report: reported === undefined ? "missing" : "present",
        },
      };
  }
};
