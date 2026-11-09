import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { toPullRequestRows } from "./gitHubPullRequestJson.ts";

export const through =
  <S extends Schema.Codec<unknown, unknown>, A>(schema: S, map: (result: S["Type"]) => A | null) =>
  (raw: string): Result.Result<A, unknown> => {
    const decoded = Schema.decodeUnknownResult(schema)(
      (JSON.parse(raw) as { readonly data: unknown }).data,
    );
    if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
    const mapped = map(decoded.success);
    return mapped === null ? Result.fail("not found") : Result.succeed(mapped);
  };

export const user = (login: string, fields: Record<string, unknown> = {}) => ({
  __typename: "User",
  login,
  ...fields,
});

const row = (fields: Record<string, unknown>) => ({
  number: 1,
  title: "Add the pull requests page",
  url: "https://github.com/goat-si/goat/pull/1",
  author: null,
  headRefName: "feat/page",
  baseRefName: "main",
  state: "OPEN",
  isDraft: false,
  mergeable: "UNKNOWN",
  reviewDecision: null,
  latestReviews: { nodes: [] },
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-02T00:00:00Z",
  mergedAt: null,
  repository: { nameWithOwner: "goat-si/goat" },
  reviewRequests: { nodes: [] },
  labels: { nodes: [] },
  commits: { nodes: [] },
  ...fields,
});

export const listPage = (page: ReturnType<typeof toPullRequestRows>) => ({
  items: page.rows.map((row) => ({
    ...row.item,
    ...(row.repository === null ? {} : { repository: row.repository }),
  })),
  rawCount: page.rawCount,
});

export type Json = Record<string, any>;
export const LAST_PAGE = { hasNextPage: false, endCursor: null };
const nodesIn = (connection: Json | null | undefined): ReadonlyArray<Json> =>
  connection?.["nodes"] ?? [];
const actor = (raw: Json | null | undefined) =>
  raw === null || raw === undefined ? null : { __typename: "User", avatarUrl: "", ...raw };
const reactionGroups = (groups: ReadonlyArray<Json> | undefined) =>
  (groups ?? []).map(({ reactors, ...group }) => ({
    viewerHasReacted: false,
    ...group,
    reactors: {
      totalCount: 0,
      ...reactors,
      nodes: nodesIn(reactors).map((node) => ({ __typename: "User", ...node })),
    },
  }));
const remark = ({ author, reactionGroups: groups, ...raw }: Json) => ({
  body: "",
  lastEditedAt: null,
  isMinimized: false,
  url: "https://github.com/acme/web/pull/1#discussion",
  ...raw,
  author: actor(author),
  reactionGroups: reactionGroups(groups),
});
const threadCommentsOf = ({ nodes, ...connection }: Json) => ({
  totalCount: (nodes ?? []).length,
  pageInfo: LAST_PAGE,
  ...connection,
  nodes: (nodes ?? []).map(remark),
});
const requestedReviewer = (raw: Json | null) =>
  raw === null
    ? null
    : "login" in raw
      ? { name: null, ...actor(raw) }
      : { __typename: "Team", ...raw };
const reviewCommit = ({ commit: { authors, ...commit } }: Json) => ({
  commit: {
    messageHeadline: "",
    committedDate: "",
    ...commit,
    authors: {
      nodes: nodesIn(authors).map((author) => ({
        name: null,
        avatarUrl: "",
        user: null,
        ...author,
      })),
    },
  },
});
export const withReviewDefaults = (raw: string): string => {
  const { data } = JSON.parse(raw) as { data: Json };
  const pr = data["repository"]?.["pullRequest"];
  if (pr?.["reviewThreads"] !== undefined) {
    const {
      reviewThreads,
      author,
      reactionGroups: groups,
      comments,
      reviews,
      reviewRequests,
      latestReviews,
      commits,
      ...rest
    } = pr;
    data["repository"]["pullRequest"] = {
      viewerCanUpdate: true,
      viewerDidAuthor: false,
      reviewDismissals: { pageInfo: LAST_PAGE, nodes: [] },
      ...rest,
      author: actor(author),
      reactionGroups: reactionGroups(groups),
      comments: { nodes: nodesIn(comments).map(remark) },
      reviews: { nodes: nodesIn(reviews).map(remark) },
      reviewRequests: {
        nodes: nodesIn(reviewRequests).map((node) => ({
          requestedReviewer: requestedReviewer(node["requestedReviewer"]),
        })),
      },
      latestReviews: {
        nodes: nodesIn(latestReviews).map((node) => ({
          state: "COMMENTED",
          isMinimized: false,
          ...node,
          author: actor(node["author"]),
        })),
      },
      commits: { nodes: nodesIn(commits).map(reviewCommit) },
      reviewThreads: {
        totalCount: nodesIn(reviewThreads).length,
        pageInfo: LAST_PAGE,
        ...reviewThreads,
        nodes: nodesIn(reviewThreads).map((thread) => ({
          isResolved: false,
          isOutdated: false,
          line: null,
          diffSide: "RIGHT",
          ...thread,
          comments: threadCommentsOf(thread["comments"]),
        })),
      },
    };
  }
  if (data["node"] !== undefined && data["node"] !== null) {
    data["node"] = {
      __typename: "PullRequestReviewThread",
      ...data["node"],
      comments: threadCommentsOf(data["node"]["comments"]),
    };
  }
  data["viewer"] ??= { login: "viewer" };
  return JSON.stringify({ data });
};
export function listJson(entries: ReadonlyArray<Record<string, unknown>>): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: entries.map(({ reviewRequests, latestReviews, checks, ...entry }) =>
            row({
              ...(reviewRequests === undefined
                ? {}
                : {
                    reviewRequests: {
                      nodes: (reviewRequests as ReadonlyArray<unknown>).map(
                        (requestedReviewer) => ({
                          requestedReviewer,
                        }),
                      ),
                    },
                  }),
              ...(latestReviews === undefined
                ? {}
                : {
                    latestReviews: {
                      nodes: (latestReviews as ReadonlyArray<Json>).map((review) => ({
                        isMinimized: false,
                        ...review,
                      })),
                    },
                  }),
              ...(checks === undefined
                ? {}
                : { commits: { nodes: [{ commit: { statusCheckRollup: { state: checks } } }] } }),
              ...entry,
            }),
          ),
        },
      },
    },
  });
}
