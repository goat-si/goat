import type { AtomCommandResult } from "@goat/client-runtime/state/runtime";
import {
  needsWorkspaceBasenameLookup,
  pickProjectLinkMatch,
  pickWorkspaceLinkMatch,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
  workspaceLinkLookupQuery,
} from "@goat/client-runtime/workspace-basename-lookup";
import type { EnvironmentId, ProjectId } from "@goat/contracts";
import { resolveWorkspaceFilePath } from "@goat/shared/path";
import type { AsyncResult, Atom } from "effect/reactivity";

import type { filesystemEnvironment } from "../state/filesystem";
import type { projectEnvironment } from "../state/projects";

type QueryRunner<Family> = Family extends (
  target: infer Target,
) => Atom.Atom<AsyncResult.AsyncResult<infer A, infer E>>
  ? (target: Target) => Promise<AtomCommandResult<A, E>>
  : never;

/**
 * The file a chat link names when an agent shortened it: the one match in this thread's workspace,
 * else the one match across this environment's other projects (as an absolute path), else null.
 */
export async function findChatFileLinkMatch(input: {
  readonly workspaceRelativePath: string;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly threadProjectId: ProjectId | undefined;
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
  readonly searchProjectEntries: QueryRunner<typeof projectEnvironment.searchEntries>;
  readonly getFilesystemMetadata: QueryRunner<typeof filesystemEnvironment.getMetadata>;
}): Promise<string | null> {
  const { workspaceRelativePath, cwd, environmentId } = input;
  const query = workspaceLinkLookupQuery(workspaceRelativePath, cwd);
  if (query === null) return null;
  // Search can be truncated or still scanning, so it cannot rule out the literal
  // path. A path with a folder opens as written whenever it exists.
  if (!needsWorkspaceBasenameLookup(workspaceRelativePath)) {
    const metadata = await input.getFilesystemMetadata({
      environmentId,
      input: { paths: [resolveWorkspaceFilePath(workspaceRelativePath, cwd)] },
    });
    if (metadata._tag !== "Success" || metadata.value.entries[0] !== null) return null;
  }
  const searchRoot = async (root: string) => {
    const rootQuery = workspaceLinkLookupQuery(workspaceRelativePath, root);
    if (rootQuery === null) return { root, entries: [] };
    const result = await input.searchProjectEntries({
      environmentId,
      input: { cwd: root, query: rootQuery, limit: WORKSPACE_BASENAME_LOOKUP_LIMIT, kind: "file" },
    });
    return { root, entries: result._tag === "Success" ? result.value.entries : [] };
  };
  const own = await searchRoot(cwd);
  const ownMatch = pickWorkspaceLinkMatch(workspaceRelativePath, cwd, own.entries);
  if (ownMatch !== null) return ownMatch;
  const otherRoots = input.projects.flatMap((project) =>
    project.environmentId === environmentId &&
    project.id !== input.threadProjectId &&
    project.workspaceRoot !== cwd
      ? [project.workspaceRoot]
      : [],
  );
  if (otherRoots.length === 0) return null;
  // Another project's file never replaces a thread-local file the search missed.
  if (needsWorkspaceBasenameLookup(workspaceRelativePath)) {
    const metadata = await input.getFilesystemMetadata({
      environmentId,
      input: { paths: [resolveWorkspaceFilePath(workspaceRelativePath, cwd)] },
    });
    if (metadata._tag !== "Success" || metadata.value.entries[0] !== null) return null;
  }
  return pickProjectLinkMatch(workspaceRelativePath, [
    own,
    ...(await Promise.all(otherRoots.map(searchRoot))),
  ]);
}
