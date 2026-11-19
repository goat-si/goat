import {
  PullRequestOperationError,
  PullRequestUnavailableError,
  type ProjectId,
  type PullRequestListResult,
} from "@goat/contracts";

/**
 * Notes a project whose checkout resolves to a host other than its stored identity's (an SSH
 * remote with its own HTTP authority), so the list names which projects that host serves.
 */
export function noteRefinedHost(byHost: Map<string, ProjectId[]>, host: string, id: ProjectId) {
  const projectIds = byHost.get(host);
  if (projectIds === undefined) byHost.set(host, [id]);
  else projectIds.push(id);
}

/** A list that read no repository: no entries, and the repositories it could not read. */
export const unreadListResult = (
  viewers: Readonly<Record<string, string>>,
  providers: PullRequestListResult["providers"],
  errors: PullRequestListResult["errors"],
): PullRequestListResult => ({
  viewers: viewers as PullRequestListResult["viewers"],
  providers,
  entries: [],
  errors,
  truncated: false,
  nextCursors: {},
});

/**
 * The list's failure, unchanged in kind so retries behave as before, carrying what the list could
 * still say so a client can try another of its servers for these hosts.
 */
export const withListResult = (
  error: PullRequestUnavailableError | PullRequestOperationError,
  listResult: PullRequestListResult,
): PullRequestUnavailableError | PullRequestOperationError =>
  error._tag === "PullRequestUnavailableError"
    ? new PullRequestUnavailableError({ ...error, listResult })
    : new PullRequestOperationError({ ...error, listResult });
