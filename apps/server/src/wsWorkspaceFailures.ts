import type {
  FilesystemBrowseFailure,
  ProjectEntriesFailure,
  ProjectFileFailure,
  ProjectFileOperation,
} from "@goat/contracts";

import type * as KnownWorkspaces from "./workspace/KnownWorkspaces.ts";
import type * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import type * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import type * as WorkspacePaths from "./workspace/WorkspacePaths.ts";

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

export function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceEntriesReadDirectoryError":
      return {
        failure: "directory_list_failed",
        ...(error.cwd !== undefined ? { normalizedCwd: error.cwd } : {}),
        detail: error.message,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
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

export function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError
    | KnownWorkspaces.UnknownWorkspaceError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
    case "UnknownWorkspaceError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceFileSystemOperationError":
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      };
    case "WorkspaceFilePathEscapeError":
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    case "WorkspacePathNotFileError":
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    case "WorkspaceFileChangedOnDiskError":
      return { failure: "changed_on_disk" };
    case "WorkspaceFileDeletedOnDiskError":
      return { failure: "deleted_on_disk" };
    case "WorkspaceUnsupportedTextFormatError":
      return { failure: "unsupported_text_format" };
    case "WorkspaceBinaryFileError":
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}
