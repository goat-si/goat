import { decodeJsonResult } from "@goat/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { GitLabPullRequestCli, GitLabPullRequestCliError } from "./GitLabPullRequestCli.ts";
import { GitLabMutationRefusedError } from "./gitLabPullRequestErrors.ts";

const SET_REVIEWER = `mutation($projectPath: ID!, $iid: String!, $reviewers: [String!]!) {
  mergeRequestSetReviewers(
    input: { projectPath: $projectPath, iid: $iid, reviewerUsernames: $reviewers, operationMode: APPEND }
  ) { errors }
}`;
const REQUEST_CHANGES = `mutation($projectPath: ID!, $iid: String!) {
  mergeRequestRequestChanges(input: { projectPath: $projectPath, iid: $iid }) { errors }
}`;
const decode = decodeJsonResult(
  Schema.Struct({
    data: Schema.optional(
      Schema.NullOr(
        Schema.Record(
          Schema.String,
          Schema.NullOr(
            Schema.Struct({ errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))) }),
          ),
        ),
      ),
    ),
    errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
  }),
);

export function makeGitLabRequestChanges(
  read: <A>(input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly operation: string;
    readonly query: string;
    readonly variables: Record<string, unknown>;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }) => Effect.Effect<A, GitLabPullRequestCliError>,
  viewer: GitLabPullRequestCli["Service"]["getViewerUsername"],
) {
  return Effect.fn("GitLabPullRequestCli.requestChanges")(function* (
    input: Parameters<GitLabPullRequestCli["Service"]["submitReview"]>[0],
  ) {
    const username = yield* viewer(input);
    const target = { projectPath: input.repository, iid: String(input.number) };
    // Older GitLab versions must fail before any comments are posted.
    for (const [query, variables] of [
      [SET_REVIEWER, { ...target, reviewers: [username] }],
      [REQUEST_CHANGES, target],
    ] as const) {
      const result = yield* read({ ...input, operation: "submitReview", query, variables, decode });
      const payloads = Object.values(result.data ?? {});
      const reasons = [
        ...(result.errors ?? []).map((error) => error.message),
        ...payloads.flatMap((payload) => payload?.errors ?? []),
      ];
      if (
        reasons.length === 0 &&
        (payloads.length === 0 || payloads.some((payload) => payload === null))
      ) {
        reasons.push("GitLab returned no mutation result");
      }
      if (reasons.length > 0) {
        return yield* new GitLabMutationRefusedError({
          command: "glab",
          cwd: input.cwd,
          operation: "submitReview",
          reasons,
        });
      }
    }
  });
}
