import type { FilesystemBrowseFailure } from "@goat/contracts";

import type * as WorkspaceEntries from "./WorkspaceEntries.ts";

export function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

export function filesystemBrowseFailureContext(
  error: WorkspaceEntries.WorkspaceEntriesBrowseError,
): {
  readonly failure: FilesystemBrowseFailure;
  readonly parentPath?: string;
  readonly platform?: string;
  readonly pathMissing?: boolean;
} {
  switch (error._tag) {
    case "WorkspaceEntriesWindowsPathUnsupportedError":
      return { failure: "windows_path_unsupported", platform: error.platform };
    case "WorkspaceEntriesCurrentProjectRequiredError":
      return { failure: "current_project_required" };
    case "WorkspaceEntriesReadDirectoryError":
      return {
        failure: "read_directory_failed",
        parentPath: error.parentPath,
        ...(error.pathMissing ? { pathMissing: true } : {}),
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}
