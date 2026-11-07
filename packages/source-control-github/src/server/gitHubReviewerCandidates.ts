import type {
  PullRequestReviewerCandidate,
  PullRequestReviewerCandidateList,
} from "@goat/contracts";
import type { ReviewerCandidates } from "./pullRequestReads.graphql.ts";
import { trimmed } from "./gitHubPullRequestJson.ts";

function nodesOf<A>(
  connection: { readonly nodes?: ReadonlyArray<A | null> | null | undefined } | null | undefined,
): ReadonlyArray<A> {
  return (connection?.nodes ?? []).flatMap((node) => (node === null ? [] : [node]));
}

/** assignableUsers avoids push/read:org requirements. Keep requested outsiders/apps removable. */
export function toReviewerCandidates(
  result: ReviewerCandidates.Result,
  query?: string,
): PullRequestReviewerCandidateList | null {
  const repository = result.repository;
  if (repository == null) return null;
  const pullRequest = repository.pullRequest;
  const author = trimmed(pullRequest?.author?.login);
  const candidates = new Map<string, PullRequestReviewerCandidate>();
  for (const { requestedReviewer: raw } of nodesOf(pullRequest?.reviewRequests)) {
    if (raw === null) continue;
    const slug = "slug" in raw ? trimmed(raw.slug) : null;
    const id = slug ?? ("login" in raw ? trimmed(raw.login) : null);
    if (id === null) continue;
    candidates.set(`${slug === null ? "user" : "team"} ${id}`, {
      id,
      kind: slug === null ? "user" : "team",
      // Match reviewer rows' org/slug so requests can be withdrawn.
      login: slug === null ? id : (trimmed("combinedSlug" in raw ? raw.combinedSlug : null) ?? id),
      name: trimmed("teamName" in raw ? raw.teamName : "name" in raw ? raw.name : null),
      avatarUrl: trimmed(
        "teamAvatarUrl" in raw ? raw.teamAvatarUrl : "avatarUrl" in raw ? raw.avatarUrl : null,
      ),
      isRequested: true,
    });
  }
  const hostMatches = new Set<string>();
  for (const node of nodesOf(repository.assignableUsers)) {
    const login = trimmed(node.login);
    if (login !== null) hostMatches.add(login);
    if (login === null || login === author || candidates.has(`user ${login}`)) continue;
    candidates.set(`user ${login}`, {
      id: login,
      kind: "user",
      login,
      name: trimmed(node.name),
      avatarUrl: trimmed(node.avatarUrl),
      isRequested: false,
    });
  }
  return {
    candidates: [...candidates.values()].filter(
      (candidate) => !query?.trim() || (candidate.kind === "user" && hostMatches.has(candidate.id)),
    ),
    truncated: repository.assignableUsers.pageInfo.hasNextPage,
  };
}

export interface GitHubReviewerCandidateInput {
  readonly cwd: string;
  readonly repository: string;
  readonly host: string;
  readonly number: number;
  readonly query?: string | undefined;
}
