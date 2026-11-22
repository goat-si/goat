import { CommandId, ProjectId, ThreadId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import {
  CHANNEL_WORKER_RELEASE_DENIED,
  ChannelWorkerReleaseDenied,
} from "../../channels/channelWorkerReleaseAuthority.ts";

import { classifyPreparationFailure } from "./PreparationFailure.ts";

export class ThreadLaunchError extends Schema.TaggedError<ThreadLaunchError>()(
  "ThreadLaunchError",
  {
    operation: Schema.Literals([
      "resolve-project",
      "read-receipt",
      "generate-metadata",
      "provision-worktree",
      "run-setup-script",
      "create-thread",
      "update-thread",
      "dispatch-message",
      "release-run",
      "fail-run",
    ]),
    commandId: CommandId,
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread launch ${this.commandId} failed during ${this.operation}.`;
  }
}

const isThreadLaunchError = Schema.is(ThreadLaunchError);
const isChannelWorkerReleaseDenied = Schema.is(ChannelWorkerReleaseDenied);

export function failureDetail(error: unknown): string {
  if (isChannelWorkerReleaseDenied(error)) return error.reason;
  if (isThreadLaunchError(error)) {
    const cause = error.cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    return `Workspace preparation failed during ${error.operation.replaceAll("-", " ")}: ${detail}`;
  }
  return `Workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`;
}

export const preparationFailureClass = (error: unknown) =>
  isChannelWorkerReleaseDenied(error)
    ? { code: CHANNEL_WORKER_RELEASE_DENIED, retryable: false as const }
    : classifyPreparationFailure(isThreadLaunchError(error) ? error.cause : error);
