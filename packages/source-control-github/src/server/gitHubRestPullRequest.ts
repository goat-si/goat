import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@goat/shared/schemaJson";

export const decodeRestPullRequests = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeRestPullRequest = Schema.decodeUnknownOption(
  Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    html_url: Schema.String,
    state: Schema.String,
    draft: Schema.optional(Schema.Boolean),
    merged_at: Schema.NullOr(Schema.String),
    closed_at: Schema.NullOr(Schema.String),
    updated_at: Schema.String,
    base: Schema.Struct({ ref: Schema.String, repo: Schema.Struct({ full_name: Schema.String }) }),
    head: Schema.Struct({
      ref: Schema.String,
      sha: Schema.String,
      repo: Schema.NullOr(
        Schema.Struct({
          name: Schema.String,
          full_name: Schema.String,
          owner: Schema.Struct({ login: Schema.String, type: Schema.String }),
        }),
      ),
    }),
  }),
);

/** Reshapes a REST pull request into the GraphQL node so both decode the same way. */
export function restPullRequestNode(entry: unknown) {
  const pr = Option.getOrNull(decodeRestPullRequest(entry));
  if (pr === null) return null;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    baseRefName: pr.base.ref,
    headRefName: pr.head.ref,
    headRefOid: pr.head.sha,
    state: pr.merged_at === null ? pr.state.toUpperCase() : "MERGED",
    isDraft: pr.draft === true,
    mergedAt: pr.merged_at,
    closedAt: pr.closed_at,
    updatedAt: pr.updated_at,
    isCrossRepository: pr.head.repo?.full_name !== pr.base.repo.full_name,
    headRepository: pr.head.repo && {
      name: pr.head.repo.name,
      nameWithOwner: pr.head.repo.full_name,
    },
    headRepositoryOwner: pr.head.repo && {
      __typename: pr.head.repo.owner.type,
      login: pr.head.repo.owner.login,
    },
  };
}
