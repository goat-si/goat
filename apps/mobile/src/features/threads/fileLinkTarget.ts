import { AuthFilesystemReadScope, type EnvironmentId } from "@goat/contracts";
import { executeAtomQuery } from "@goat/client-runtime/state/runtime";
import {
  needsWorkspaceBasenameLookup,
  pickWorkspaceLinkMatch,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
  workspaceLinkLookupQuery,
} from "@goat/client-runtime/workspace-basename-lookup";

import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { readEnvironmentScope } from "../../state/session";
import { resolveWorkspaceFilePath, resolveWorkspaceRelativeFilePath } from "../files/filePath";

/**
 * The path the file route opens for a chat file link: the one workspace file the link names when
 * an agent shortened it (a basename, a package-relative path, a repeated prefix), else the link.
 */
export async function findFileLinkTarget(input: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string | null | undefined;
  readonly linkPath: string;
  readonly path: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const { environmentId, linkPath, path, signal } = input;
  const relativePath = resolveWorkspaceRelativeFilePath(input.workspaceRoot, path);
  if (
    !input.workspaceRoot ||
    !relativePath ||
    /[\\/]$/.test(linkPath) ||
    workspaceLinkLookupQuery(linkPath, input.workspaceRoot) === null ||
    !readEnvironmentScope(environmentId, AuthFilesystemReadScope)
  ) {
    return relativePath ?? path;
  }
  const workspaceRoot = input.workspaceRoot;
  const originalPath = resolveWorkspaceFilePath(workspaceRoot, relativePath);
  const queryOptions = { signal, reportFailure: false, reportDefect: false };
  const lookup = async () => {
    const result = await executeAtomQuery(
      appAtomRegistry,
      projectEnvironment.searchEntries({
        environmentId,
        input: {
          cwd: workspaceRoot,
          query: workspaceLinkLookupQuery(relativePath, workspaceRoot) ?? relativePath,
          kind: "file",
          limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
        },
      }),
      queryOptions,
    );
    const match =
      result._tag === "Success"
        ? pickWorkspaceLinkMatch(relativePath, workspaceRoot, result.value.entries)
        : null;
    if (!match || match === relativePath || signal.aborted) return relativePath;
    const metadata = await executeAtomQuery(
      appAtomRegistry,
      projectEnvironment.fileMetadata({ environmentId, input: { path: originalPath } }),
      queryOptions,
    );
    // A basename opens its match unless it names a folder; a path with a folder only when the
    // literal path is missing, since search can be truncated or still scanning.
    return metadata._tag === "Success" &&
      (needsWorkspaceBasenameLookup(relativePath)
        ? metadata.value?.kind !== "directory"
        : metadata.value === null)
      ? match
      : relativePath;
  };
  return lookup().catch(() => relativePath);
}
