import * as Schema from "effect/Schema";
import { MessageId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@goat/contracts";

export class ThreadManagementThreadNotFoundError extends Schema.TaggedError<ThreadManagementThreadNotFoundError>()(
  "ThreadManagementThreadNotFoundError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found in project ${this.projectId}.`;
  }
}

export class ThreadTranscriptTooLargeError extends Schema.TaggedError<ThreadTranscriptTooLargeError>()(
  "ThreadTranscriptTooLargeError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "The thread transcript exceeds the file attachment limit.";
  }
}

export class ThreadManagementRunNotFoundError extends Schema.TaggedError<ThreadManagementRunNotFoundError>()(
  "ThreadManagementRunNotFoundError",
  {
    threadId: ThreadId,
    runId: RunId,
  },
) {
  override get message(): string {
    return `Run ${this.runId} does not belong to thread ${this.threadId}.`;
  }
}

export class ThreadManagementThreadArchivedError extends Schema.TaggedError<ThreadManagementThreadArchivedError>()(
  "ThreadManagementThreadArchivedError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} is archived and cannot receive messages.`;
  }
}

export class ThreadManagementNoSteerableRunError extends Schema.TaggedError<ThreadManagementNoSteerableRunError>()(
  "ThreadManagementNoSteerableRunError",
  {
    threadId: ThreadId,
    mode: Schema.Literals(["steer", "restart"]),
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} has no running turn that can be ${this.mode === "steer" ? "steered" : "restarted"}.`;
  }
}

export class ThreadManagementReviewTaskFinishedError extends Schema.TaggedError<ThreadManagementReviewTaskFinishedError>()(
  "ThreadManagementReviewTaskFinishedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Review task on thread ${this.threadId} has finished. Start the next round with goat_task_create role='review': continueFrom=<its taskId> keeps this reviewer; omit it for a fresh one.`;
  }
}

export class ThreadManagementTargetStoppedError extends Schema.TaggedError<ThreadManagementTargetStoppedError>()(
  "ThreadManagementTargetStoppedError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `The turn on thread ${this.threadId} was stopped before it could take the message. Send it again to start a new turn.`;
  }
}

export class ThreadManagementThreadNotInterruptibleError extends Schema.TaggedError<ThreadManagementThreadNotInterruptibleError>()(
  "ThreadManagementThreadNotInterruptibleError",
  {
    threadId: ThreadId,
    runId: RunId,
  },
) {
  override get message(): string {
    return `Run ${this.runId} is not currently interruptible.`;
  }
}

export class ThreadManagementProjectionLoadError extends Schema.TaggedError<ThreadManagementProjectionLoadError>()(
  "ThreadManagementProjectionLoadError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Unable to load thread ${this.threadId} in project ${this.projectId}.`;
  }
}

export class ThreadManagementProjectThreadsListError extends Schema.TaggedError<ThreadManagementProjectThreadsListError>()(
  "ThreadManagementProjectThreadsListError",
  {
    /** Absent when every project was listed. */
    projectId: Schema.optional(ProjectId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.projectId === undefined
      ? "Unable to list threads."
      : `Unable to list threads in project ${this.projectId}.`;
  }
}

export class ThreadManagementDurableRunProjectionError extends Schema.TaggedError<ThreadManagementDurableRunProjectionError>()(
  "ThreadManagementDurableRunProjectionError",
  {
    threadId: ThreadId,
    messageId: MessageId,
  },
) {
  override get message(): string {
    return `Message ${this.messageId} was accepted on thread ${this.threadId} without a durable run projection.`;
  }
}

export class ThreadManagementProviderInstanceDisabledError extends Schema.TaggedError<ThreadManagementProviderInstanceDisabledError>()(
  "ThreadManagementProviderInstanceDisabledError",
  {
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `Provider instance "${this.instanceId}" is disabled for project ${this.projectId}.`;
  }
}

export class ThreadManagementBackgroundWaitError extends Schema.TaggedError<ThreadManagementBackgroundWaitError>()(
  "ThreadManagementBackgroundWaitError",
  {
    threadId: ThreadId,
    reason: Schema.Literals(["unsupported", "unavailable", "failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "This provider cannot mark background work as awaited.";
      case "unavailable":
        return "This thread has no live provider session.";
      case "failed":
        return "Failed to update the awaited background work.";
    }
  }
}

export const ThreadManagementError = Schema.Union([
  ThreadManagementThreadNotFoundError,
  ThreadManagementRunNotFoundError,
  ThreadManagementThreadArchivedError,
  ThreadManagementNoSteerableRunError,
  ThreadManagementTargetStoppedError,
  ThreadManagementReviewTaskFinishedError,
  ThreadManagementThreadNotInterruptibleError,
  ThreadManagementProjectionLoadError,
  ThreadManagementProjectThreadsListError,
  ThreadManagementDurableRunProjectionError,
  ThreadManagementProviderInstanceDisabledError,
]);
export type ThreadManagementError = typeof ThreadManagementError.Type;
