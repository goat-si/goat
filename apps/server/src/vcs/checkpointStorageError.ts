import { VcsProcessExitError } from "@goat/contracts";
import * as Schema from "effect/Schema";

export class VcsCheckpointStorageError extends Schema.TaggedError<VcsCheckpointStorageError>()(
  "VcsCheckpointStorageError",
  {
    operation: Schema.String,
    cwd: Schema.String,
    stage: Schema.Literals(["isolate", "publish"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.stage} checkpoint objects.`;
  }
}

const isCheckpointStorageError = Schema.is(VcsCheckpointStorageError);

export function mapCheckpointStorageError<E>(
  error: E,
): Exclude<E, VcsCheckpointStorageError> | VcsProcessExitError {
  return isCheckpointStorageError(error)
    ? new VcsProcessExitError({
        operation: error.operation,
        command: "git",
        cwd: error.cwd,
        exitCode: 1,
        detail: error.message,
      })
    : (error as Exclude<E, VcsCheckpointStorageError>);
}

const isVcsProcessExitError = Schema.is(VcsProcessExitError);
export function isMappedCheckpointStorageError(error: unknown): error is VcsProcessExitError {
  return (
    isVcsProcessExitError(error) &&
    /^Could not (isolate|publish) checkpoint objects\.$/.test(error.detail)
  );
}
