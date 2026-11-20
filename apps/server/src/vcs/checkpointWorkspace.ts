import { VcsProcessExitError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

export function recreateCheckpointWorkspace(
  fileSystem: FileSystem.FileSystem,
  cwd: string,
  operation: string,
) {
  // Restoring away the last tracked file can remove a nested workspace directory.
  return fileSystem.makeDirectory(cwd, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new VcsProcessExitError({
          operation,
          command: "git restore",
          cwd,
          exitCode: 0,
          detail: `Could not recreate the checkpoint workspace: ${cause.message}`,
        }),
    ),
  );
}
