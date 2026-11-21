/**
 * How a channel task settles once its worker's current run ended `completed`. The outcome the
 * worker reported with goat_thread_report_result decides what the requester sees; a successful
 * GOAT Bot turn delivers its own final text. Local and remote workers share this one rule.
 *
 * @module channelRunOutcome
 */
import type { ChannelTask, OrchestrationV2Run, RunId, ThreadResultOutcome } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";

import { questionIdFor } from "./channelIds.ts";
import {
  CHANNEL_PERMISSION_CHANGED,
  CHANNEL_PERMISSION_CHANGED_MESSAGE,
} from "./channelProviderInputAuthority.ts";
import type { ChannelTaskEventSpec } from "./channelTaskWrites.ts";

export interface ReportedRunOutcome {
  readonly outcome: ThreadResultOutcome;
  readonly summary?: string | undefined;
}

const REPORTED_FAILED_FALLBACK = "The worker reported that it could not finish.";
const REPORTED_CANCELLED_FALLBACK = "The worker reported that it stopped before finishing.";
const REPORTED_BLOCKED_FALLBACK =
  "The worker reported that it is blocked without giving a reason. How should it continue?";
/** What callers settle with when a run left no text of its own. */
const NO_FINAL_TEXT = "Finished.";

export const channelRunFailure = Effect.fn("channel.runFailure")(function* (
  threads: ThreadManagementService["Service"],
  run: OrchestrationV2Run,
  session: boolean,
) {
  if (session && run.status === "failed") {
    const errors = yield* threads
      .getThreadRecords(run.threadId, ["turnItems"], {
        turnItemTypes: ["error"],
        turnItemRunIds: [run.id],
      })
      .pipe(Effect.option);
    if (Option.isNone(errors)) return undefined;
    if (
      errors.value.turnItems.some(
        (item) => item.type === "error" && item.failure.code === CHANNEL_PERMISSION_CHANGED,
      )
    ) {
      return { reason: CHANNEL_PERMISSION_CHANGED, summary: CHANNEL_PERMISSION_CHANGED_MESSAGE };
    }
  }
  return {
    reason: run.status,
    summary: "The coding thread ended with " + run.status.replaceAll("_", " ") + ".",
  };
});

/**
 * The event that settles `task` after run `runId` completed. `fallbackSummary` is what the task
 * said before reports existed (the last assistant message, a proposed completion, "Finished.").
 */
export const settleCompletedRun = (input: {
  readonly task: ChannelTask;
  readonly runId: RunId;
  readonly reported: ReportedRunOutcome | undefined;
  readonly finalReportDue?: boolean;
  readonly fallbackSummary: string;
  readonly now: string;
}): ChannelTaskEventSpec => {
  const { task, runId, reported } = input;
  if (input.finalReportDue) {
    const text = input.fallbackSummary.trim();
    const reason = "The bot ended without a final report after its delegated work finished.";
    return {
      type: "task.failed",
      payload: {
        generation: task.generation,
        reason: "missing_final_report",
        summary: text && text !== NO_FINAL_TEXT ? reason + "\n\n" + text : reason,
      },
    };
  }
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
    case undefined: {
      // A turn's final text is its answer to the person, at the length it needs; the report's
      // summary stands in only when the turn left none.
      const fallback = input.fallbackSummary.trim();
      const turnAnswer =
        task.kind === "turn" && fallback !== "" && fallback !== NO_FINAL_TEXT
          ? input.fallbackSummary
          : undefined;
      return {
        type: "task.completed",
        payload: {
          generation: task.generation,
          runId,
          summary: turnAnswer ?? summary ?? input.fallbackSummary,
          report: reported === undefined ? "missing" : "present",
        },
      };
    }
  }
};

/** Whether a worker that asked a question then reported failing or stopping, after every question. */
export const failedAfterAsking = (
  task: Pick<ChannelTask, "openQuestions">,
  result:
    | {
        readonly outcome: ThreadResultOutcome | null;
        readonly reportedAt?: string | null | undefined;
      }
    | undefined,
): boolean => {
  const reportedAt = result?.reportedAt ?? null;
  return (
    reportedAt !== null &&
    (result?.outcome === "failed" || result?.outcome === "cancelled") &&
    task.openQuestions.every(({ askedAt }) => Date.parse(askedAt) <= Date.parse(reportedAt))
  );
};
