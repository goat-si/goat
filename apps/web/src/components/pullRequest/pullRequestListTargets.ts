import type {
  EnvironmentId,
  ProjectId,
  PullRequestListCursors,
  PullRequestListInput,
} from "@goat/contracts";

import type { EnvironmentQueryTarget } from "~/state/pullRequests";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";

type PullRequestEnvironmentQuery = {
  readonly environmentId: EnvironmentId;
  readonly projectIds?: ReadonlyArray<ProjectId>;
};

export function preferredPullRequestEntries(queries: ReadonlyArray<PullRequestEnvironmentQuery>) {
  const wholeEnvironments = new Set<EnvironmentId>();
  const projectsByEnvironment = new Map<EnvironmentId, Set<ProjectId>>();
  for (const { environmentId, projectIds } of queries) {
    if (projectIds === undefined) {
      wholeEnvironments.add(environmentId);
      continue;
    }
    const projects = projectsByEnvironment.get(environmentId) ?? new Set<ProjectId>();
    for (const id of projectIds) projects.add(id);
    projectsByEnvironment.set(environmentId, projects);
  }
  return ({ environmentId, projectId }: EnvironmentPullRequestEntry) =>
    wholeEnvironments.has(environmentId) ||
    projectsByEnvironment.get(environmentId)?.has(projectId) === true;
}

/**
 * The list reads for these environment queries. With paging, an environment the last page left
 * no cursor for (and that did not regrow) is not asked again.
 */
export function pullRequestListTargets(
  queries: ReadonlyArray<PullRequestEnvironmentQuery>,
  input: Omit<PullRequestListInput, "projectIds" | "cursors">,
  paging?: {
    readonly sent: Readonly<Record<string, PullRequestListCursors>> | null;
    readonly regrown: ReadonlyArray<string>;
  },
): Array<EnvironmentQueryTarget<PullRequestListInput>> {
  return queries.flatMap(({ environmentId, projectIds }) => {
    const cursors = paging?.sent?.[environmentId];
    if (paging?.sent && cursors === undefined && !paging.regrown.includes(environmentId)) {
      return [];
    }
    const target: PullRequestListInput = {
      ...input,
      ...(projectIds ? { projectIds } : {}),
      ...(cursors === undefined ? {} : { cursors }),
    };
    return [{ environmentId, input: target }];
  });
}
