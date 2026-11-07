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

export const row = (fields: Record<string, unknown>) => ({
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
