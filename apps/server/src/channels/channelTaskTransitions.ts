import type { ChannelTask, ChannelTaskEvent, ChannelTaskStatus } from "@goat/contracts";

/**
 * The task state machine. Every ledger write that moves a task goes through
 * `applyChannelTaskEvent`, so a stale generation, a report for a finished task, or a jump the
 * ledger does not allow is rejected the same way no matter which worker produced it.
 */

export type ChannelTaskTransition =
  | { readonly ok: true; readonly task: ChannelTask }
  | { readonly ok: false; readonly reason: string };

const reject = (reason: string): ChannelTaskTransition => ({ ok: false, reason });

/** A finished task keeps the pull requests it produced; nothing is waiting on anyone anymore. */
const settledObservation = (task: ChannelTask): Partial<Pick<ChannelTask, "observed">> =>
  task.observed === undefined
    ? {}
    : {
        observed: {
          pullRequests: task.observed.pullRequests,
          needsYou: [],
          ...(task.observed.result === undefined ? {} : { result: task.observed.result }),
        },
      };

const allowedFrom: Record<ChannelTaskEvent["type"], ReadonlyArray<ChannelTaskStatus>> = {
  "task.created": [],
  "task.dispatch.claimed": ["received"],
  "task.brief.frozen": ["dispatching"],
  "task.worker.bound": ["dispatching", "running", "reviewing", "waiting_input"],
  "task.progress": ["running"],
  // A question can open while another waits: a follow-up the worker refused asks its own.
  "task.question.opened": ["received", "dispatching", "running", "reviewing", "waiting_input"],
  "task.question.answered": ["waiting_input"],
  "task.followup.received": ["running", "reviewing"],
  "task.completion.proposed": ["running"],
  "task.review.started": ["running"],
  "task.review.bound": ["reviewing"],
  "task.review.finished": ["reviewing", "cancelled"],
  "task.completed": ["running", "reviewing"],
  "task.failed": ["received", "dispatching", "running", "reviewing", "waiting_input"],
  "task.cancelled": ["received", "dispatching", "running", "reviewing", "waiting_input"],
  "task.retry.requested": ["completed", "failed", "cancelled"],
  "task.worker.observed": [
    "running",
    "reviewing",
    "waiting_input",
    "completed",
    "failed",
    "cancelled",
  ],
  "task.moved": ["dispatching", "running", "waiting_input"],
};

const eventGeneration = (event: ChannelTaskEvent): number | undefined => {
  switch (event.type) {
    case "task.dispatch.claimed":
    case "task.progress":
    case "task.completed":
    case "task.failed":
    case "task.worker.observed":
    case "task.review.bound":
      return event.payload.generation;
    case "task.brief.frozen":
      return event.payload.brief.generation;
    case "task.worker.bound":
      return event.payload.worker.generation;
    case "task.completion.proposed":
      return event.payload.proposal.generation;
    case "task.review.started":
    case "task.review.finished":
      return event.payload.review.generation;
    default:
      return undefined;
  }
};

/** Builds the next task snapshot for `event`, or explains why the ledger refuses it. */
export function applyChannelTaskEvent(
  task: ChannelTask,
  event: ChannelTaskEvent,
): ChannelTaskTransition {
  if (event.taskId !== task.taskId) return reject("The event belongs to another task.");
  if (event.taskVersion !== task.version + 1) {
    return reject(`Expected task version ${task.version + 1}, got ${event.taskVersion}.`);
  }
  if (!allowedFrom[event.type].includes(task.status)) {
    return reject(`${event.type} is not allowed while the task is ${task.status}.`);
  }
  if (event.type === "task.retry.requested" || event.type === "task.moved") {
    if (event.payload.generation !== task.generation + 1) {
      return reject(
        event.type === "task.moved"
          ? "A move must start the next generation."
          : "A retry must start the next generation.",
      );
    }
  } else {
    const generation = eventGeneration(event);
    if (generation !== undefined && generation !== task.generation) {
      return reject(`Generation ${generation} is not the task's current generation.`);
    }
  }

  const base = { ...task, version: event.taskVersion, updatedAt: event.occurredAt };
  switch (event.type) {
    case "task.created":
      return reject("A task is created, not transitioned.");
    case "task.dispatch.claimed":
      return {
        ok: true,
        task: {
          ...base,
          status: "dispatching",
          target: event.payload.target,
          projectId: event.payload.target.projectId,
          ...(event.payload.target.remote === undefined
            ? {}
            : { host: event.payload.target.remote.host }),
        },
      };
    case "task.brief.frozen":
      if (task.briefVersion !== undefined) return reject("This generation already has a brief.");
      return { ok: true, task: { ...base, briefVersion: event.payload.brief.version } };
    case "task.worker.bound":
      // A newer run on a waiting worker does not answer its open questions.
      return {
        ok: true,
        task: {
          ...base,
          status:
            task.status === "waiting_input"
              ? "waiting_input"
              : task.status === "reviewing" && task.worker?.runId === event.payload.worker.runId
                ? "reviewing"
                : "running",
          worker: event.payload.worker,
          ...(task.observed?.result !== undefined &&
          task.observed.result.runId !== event.payload.worker.runId
            ? {
                observed: {
                  pullRequests: task.observed.pullRequests,
                  needsYou: task.observed.needsYou,
                },
              }
            : {}),
        },
      };
    case "task.progress":
      return { ok: true, task: { ...base, resultSummary: event.payload.summary } };
    case "task.question.opened":
      return {
        ok: true,
        task: {
          ...base,
          status: "waiting_input",
          openQuestions: [...task.openQuestions, event.payload.question],
        },
      };
    case "task.question.answered": {
      if (
        !task.openQuestions.some((question) => question.questionId === event.payload.questionId)
      ) {
        return reject("That question is not open on this task.");
      }
      const openQuestions = task.openQuestions.filter(
        (question) => question.questionId !== event.payload.questionId,
      );
      // A dispatcher question (no worker yet) sends the task back to dispatch; a worker question
      // goes back to the running worker, which receives the answer as a follow-up message.
      const status: ChannelTaskStatus =
        openQuestions.length > 0
          ? "waiting_input"
          : task.worker === undefined
            ? "received"
            : "running";
      return { ok: true, task: { ...base, status, openQuestions } };
    }
    // The worker takes the follow-up; the task keeps running until the run that took it settles.
    case "task.followup.received":
      if (task.status === "reviewing" && task.review?.verdict !== "blockers") {
        return reject("An open review cannot forward findings.");
      }
      return { ok: true, task: { ...base, status: "running" } };
    case "task.completion.proposed": {
      if (task.worker?.runId !== event.payload.proposal.runId) {
        return reject("The proposal names a run the task is not bound to.");
      }
      return { ok: true, task: { ...base, proposedCompletion: event.payload.proposal } };
    }
    case "task.review.started": {
      const review = event.payload.review;
      if (review.workerRunId !== task.worker?.runId || review.verdict !== undefined) {
        return reject("A review must reserve the current worker run.");
      }
      if (task.review?.workerRunId === review.workerRunId) {
        return reject("This worker run already has a review.");
      }
      return { ok: true, task: { ...base, status: "reviewing", review } };
    }
    case "task.review.finished": {
      const review = event.payload.review;
      if (
        task.review?.verdict !== undefined ||
        review.verdict === undefined ||
        review.workerRunId !== task.worker?.runId ||
        review.workerRunId !== task.review?.workerRunId ||
        review.threadId !== task.review.threadId
      )
        return reject("The review no longer owns this worker run.");
      if (task.status === "cancelled" && review.verdict !== "failed")
        return reject("A stopped task cannot pass review.");
      return { ok: true, task: { ...base, review } };
    }
    case "task.review.bound": {
      if (
        task.review === undefined ||
        task.review.verdict !== undefined ||
        task.review.workerRunId !== event.payload.workerRunId ||
        task.worker?.runId !== event.payload.workerRunId ||
        (task.review.remoteThreadId !== undefined &&
          task.review.remoteThreadId !== event.payload.threadId)
      ) {
        return reject("The reviewer binding is stale.");
      }
      return {
        ok: true,
        task: { ...base, review: { ...task.review, remoteThreadId: event.payload.threadId } },
      };
    }
    case "task.completed": {
      if (
        task.status === "reviewing" &&
        (task.review?.verdict === undefined || task.review.verdict === "blockers")
      ) {
        return reject("An open or blocked review cannot complete the task.");
      }
      if (event.payload.runId !== undefined && event.payload.runId !== task.worker?.runId) {
        return reject("Completion names an old worker run.");
      }
      const { proposedCompletion: _proposed, observed: _observed, ...rest } = base;
      return {
        ok: true,
        task: {
          ...rest,
          ...settledObservation(task),
          status: "completed",
          resultSummary: event.payload.summary,
          ...(event.payload.report === undefined ? {} : { completionReport: event.payload.report }),
          completedAt: event.occurredAt,
        },
      };
    }
    case "task.failed": {
      const { proposedCompletion: _proposed, observed: _observed, ...rest } = base;
      return {
        ok: true,
        task: {
          ...rest,
          ...settledObservation(task),
          status: "failed",
          resultSummary: event.payload.summary ?? event.payload.reason,
          completedAt: event.occurredAt,
        },
      };
    }
    case "task.cancelled": {
      const { proposedCompletion: _proposed, observed: _observed, ...rest } = base;
      return {
        ok: true,
        task: {
          ...rest,
          ...settledObservation(task),
          status: "cancelled",
          ...(event.payload.reason === undefined ? {} : { resultSummary: event.payload.reason }),
          completedAt: event.occurredAt,
        },
      };
    }
    case "task.retry.requested": {
      const automatic = base.target?.remote?.automatic;
      const {
        proposedCompletion: _proposed,
        briefVersion: _briefVersion,
        worker: _worker,
        completedAt: _completedAt,
        resultSummary: _summary,
        completionReport: _report,
        review: _review,
        observed: _observed,
        host,
        ...rest
      } = base;
      return {
        ok: true,
        task: {
          ...rest,
          ...(automatic === undefined
            ? host === undefined
              ? {}
              : { host }
            : { projectId: automatic.sourceProjectId }),
          status: "received",
          generation: event.payload.generation,
          openQuestions: [],
        },
      };
    }
    case "task.worker.observed": {
      let observed = event.payload.observed;
      if (observed.result !== undefined && observed.result.runId !== task.worker?.runId) {
        return reject("The evidence names a run the task is not bound to.");
      }
      const previous = task.observed?.result;
      if (previous !== undefined && previous.runId === observed.result?.runId) {
        const finalCheck =
          previous.observedCheck !== undefined && previous.observedCheck.status !== "running";
        observed = {
          ...observed,
          result: {
            ...previous,
            ...observed.result,
            ...(finalCheck
              ? { observedCheck: previous.observedCheck, observedCheckPending: false }
              : {}),
          },
        };
        if (
          previous.observedCheck?.status === "running" &&
          event.payload.observed.result?.observedCheck === undefined &&
          event.payload.observed.result?.observedCheckPending === false
        ) {
          const { observedCheck: _check, ...resolved } = observed.result!;
          observed = { ...observed, result: resolved };
        }
      }
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        if (observed.result === undefined)
          return reject("A finished task only accepts run evidence.");
        return {
          ok: true,
          task: {
            ...base,
            observed: {
              pullRequests: task.observed?.pullRequests ?? [],
              needsYou: [],
              result: observed.result,
            },
          },
        };
      }
      return { ok: true, task: { ...base, observed } };
    }
    case "task.moved": {
      // The new machine resolves its own project and starts a new worker from the copied work,
      // under a brief of its own, like a retry.
      const {
        proposedCompletion: _proposed,
        worker: _worker,
        target: _target,
        projectId: _projectId,
        observed: _observed,
        briefVersion: _briefVersion,
        review: _review,
        ...rest
      } = base;
      return {
        ok: true,
        task: {
          ...rest,
          status: "received",
          generation: event.payload.generation,
          host: event.payload.host,
          openQuestions: [],
          movedFrom: {
            host: event.payload.fromHost,
            generation: task.generation,
            at: event.occurredAt,
            replicaCapturedAt: event.payload.replicaCapturedAt,
          },
        },
      };
    }
  }
}
