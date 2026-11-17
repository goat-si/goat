import { scopeThreadRef } from "@goat/client-runtime/environment";
import { AuthFilesystemReadScope, type EnvironmentId, type ThreadId } from "@goat/contracts";
import { executeAtomQuery } from "@goat/client-runtime/state/runtime";
import {
  needsWorkspaceBasenameLookup,
  pickProjectLinkMatch,
  pickWorkspaceLinkMatch,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
  workspaceLinkLookupQuery,
} from "@goat/client-runtime/workspace-basename-lookup";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { readEnvironmentScope } from "../../state/session";
import { environmentThreadShells } from "../../state/threads";
import { resolveWorkspaceFilePath, resolveWorkspaceRelativeFilePath } from "../files/filePath";

/**
 * The path the file route opens for a chat file link: the one workspace file the link names when
 * an agent shortened it (a basename, a package-relative path, a repeated prefix), else the one
 * other project of this environment that has it (an absolute path), else the link.
 */
export async function findFileLinkTarget(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
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
  const searchRoot = (root: string) =>
    executeAtomQuery(
      appAtomRegistry,
      projectEnvironment.searchEntries({
        environmentId,
        input: {
          cwd: root,
          query: workspaceLinkLookupQuery(relativePath, root) ?? relativePath,
          kind: "file",
          limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
        },
      }),
      queryOptions,
    ).then((result) => ({
      root,
      entries: result._tag === "Success" ? result.value.entries : [],
    }));
  const lookup = async () => {
    const own = await searchRoot(workspaceRoot);
    let match = pickWorkspaceLinkMatch(relativePath, workspaceRoot, own.entries);
    const otherProject = match === null;
    if (otherProject) {
      const threadProjectId = appAtomRegistry.get(
        environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, input.threadId)),
      )?.projectId;
      const otherRoots = appAtomRegistry
        .get(environmentProjects.projectsAtom)
        .flatMap((project) =>
          project.environmentId === environmentId &&
          project.id !== threadProjectId &&
          project.workspaceRoot !== workspaceRoot
            ? [project.workspaceRoot]
            : [],
        );
      match =
        otherRoots.length === 0
          ? null
          : pickProjectLinkMatch(relativePath, await Promise.all(otherRoots.map(searchRoot)));
    }
    if (!match || match === relativePath || signal.aborted) return relativePath;
    const metadata = await executeAtomQuery(
      appAtomRegistry,
      projectEnvironment.fileMetadata({ environmentId, input: { path: originalPath } }),
      queryOptions,
    );
    // A basename opens its match unless it names a folder; a path with a folder only when the
    // literal path is missing, since search can be truncated or still scanning. Another
    // project's file never replaces a thread-local file the search missed.
    return metadata._tag === "Success" &&
      (needsWorkspaceBasenameLookup(relativePath) && !otherProject
        ? metadata.value?.kind !== "directory"
        : metadata.value === null)
      ? match
      : relativePath;
  };
  return lookup().catch(() => relativePath);
}
