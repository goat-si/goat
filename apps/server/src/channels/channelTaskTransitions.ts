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
  task.observed === undefined || task.observed.pullRequests.length === 0
    ? {}
    : { observed: { pullRequests: task.observed.pullRequests, needsYou: [] } };

const allowedFrom: Record<ChannelTaskEvent["type"], ReadonlyArray<ChannelTaskStatus>> = {
  "task.created": [],
  "task.dispatch.claimed": ["received"],
  "task.brief.frozen": ["dispatching"],
  "task.worker.bound": ["dispatching", "running", "waiting_input"],
  "task.progress": ["running"],
  "task.question.opened": ["received", "dispatching", "running"],
  "task.question.answered": ["waiting_input"],
  "task.completion.proposed": ["running"],
  "task.completed": ["running"],
  "task.failed": ["received", "dispatching", "running", "waiting_input"],
  "task.cancelled": ["received", "dispatching", "running", "waiting_input"],
  "task.retry.requested": ["completed", "failed", "cancelled"],
  "task.worker.observed": ["running", "waiting_input"],
  "task.moved": ["dispatching", "running", "waiting_input"],
};

const eventGeneration = (event: ChannelTaskEvent): number | undefined => {
  switch (event.type) {
    case "task.dispatch.claimed":
    case "task.progress":
    case "task.completed":
    case "task.failed":
    case "task.worker.observed":
      return event.payload.generation;
    case "task.brief.frozen":
      return event.payload.brief.generation;
    case "task.worker.bound":
      return event.payload.worker.generation;
    case "task.completion.proposed":
      return event.payload.proposal.generation;
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
          status: task.status === "waiting_input" ? "waiting_input" : "running",
          worker: event.payload.worker,
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
    case "task.completion.proposed": {
      if (task.worker?.runId !== event.payload.proposal.runId) {
        return reject("The proposal names a run the task is not bound to.");
      }
      return { ok: true, task: { ...base, proposedCompletion: event.payload.proposal } };
    }
    case "task.completed": {
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
      const {
        proposedCompletion: _proposed,
        briefVersion: _briefVersion,
        worker: _worker,
        completedAt: _completedAt,
        resultSummary: _summary,
        completionReport: _report,
        observed: _observed,
        ...rest
      } = base;
      return {
        ok: true,
        task: {
          ...rest,
          status: "received",
          generation: event.payload.generation,
          openQuestions: [],
        },
      };
    }
    case "task.worker.observed":
      return { ok: true, task: { ...base, observed: event.payload.observed } };
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
