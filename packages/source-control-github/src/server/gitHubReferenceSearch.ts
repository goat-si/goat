import type * as Effect from "effect/Effect";
import type { GitHubPullRequestApiError } from "./GitHubPullRequestApi.ts";
import type { PullRequestReferenceCandidate } from "@goat/contracts";
import type { RepositoryReferences, ReferenceCandidate } from "./pullRequestReads.graphql.ts";

/** The `search` string for {@link toRepositoryReferences}; a numeric query searches recent items. */
export function referenceSearchQuery(repository: string, query: string | undefined): string {
  const text = query?.trim() ?? "";
  const titled = text.length === 0 || /^\d+$/.test(text) ? [] : [`in:title ${searchPhrase(text)}`];
  return [`repo:${repository}`, ...titled, "sort:updated-desc"].join(" ");
}

/** Quote user text so GitHub cannot interpret it as qualifiers that widen the listing. */
export function searchPhrase(query: string): string {
  return `"${query.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

type ReferenceNode =
  | ReferenceCandidate
  | NonNullable<NonNullable<RepositoryReferences.Result["search"]["nodes"]>[number]>;

function toReferenceCandidate(node: ReferenceNode): PullRequestReferenceCandidate | null {
  if (node.__typename === "Issue") {
    return {
      reference: `#${node.number}`,
      kind: "issue",
      number: node.number,
      title: node.title,
      state: node.issueState === "OPEN" ? "open" : "closed",
    };
  }
  if (node.__typename === "PullRequest") {
    return {
      reference: `#${node.number}`,
      kind: "change-request",
      number: node.number,
      title: node.title,
      state:
        node.pullRequestState === "OPEN"
          ? "open"
          : node.pullRequestState === "MERGED"
            ? "merged"
            : "closed",
    };
  }
  return null;
}

export function toRepositoryReferences(result: RepositoryReferences.Result): {
  readonly items: ReadonlyArray<PullRequestReferenceCandidate>;
  readonly truncated: boolean;
} {
  const exact = result.repository?.issueOrPullRequest;
  const nodes = [
    ...(exact == null ? [] : [exact]),
    ...(result.search.nodes ?? []).flatMap((node) => (node === null ? [] : [node])),
  ];
  return {
    items: nodes.flatMap((node) => {
      const candidate = toReferenceCandidate(node);
      return candidate === null ? [] : [candidate];
    }),
    truncated: result.search.pageInfo.hasNextPage,
  };
}

export type SearchRepositoryReferences = (input: {
  readonly cwd: string;
  readonly repository: string;
  readonly host: string;
  readonly query?: string | undefined;
}) => Effect.Effect<
  {
    readonly items: ReadonlyArray<PullRequestReferenceCandidate>;
    readonly truncated: boolean;
  },
  GitHubPullRequestApiError
>;
