import type {
  EnvironmentId,
  ProjectId,
  PullRequestListCursors,
  PullRequestListInput,
} from "@goat/contracts";

import type { EnvironmentQueryTarget } from "~/state/pullRequests";

/**
 * The list reads for these environment queries. With paging, an environment the last page left
 * no cursor for (and that did not regrow) is not asked again.
 */
export function pullRequestListTargets(
  queries: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectIds?: ReadonlyArray<ProjectId>;
  }>,
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
