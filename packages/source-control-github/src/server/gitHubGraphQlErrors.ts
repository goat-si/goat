import * as Effect from "effect/Effect";
import { GraphQLClientError } from "effect/graphql";
import * as Schema from "effect/Schema";

import { PullRequestActionState, PullRequestCore } from "./pullRequestReads.graphql.ts";

const isGraphQlClientError = (error: unknown): error is GraphQLClientError.GraphQLClientError =>
  GraphQLClientError.isGraphQLClientError(error);

const isMissingPullRef = ({ path, type }: GraphQLClientError.GraphQLError): boolean =>
  type === "NOT_FOUND" && path?.join(".") === "repository.pullRequest.baseRef.compare";

export const isRefusedRequestedReviewersOnly = (error: unknown): boolean =>
  isGraphQlClientError(error) &&
  error.reason._tag === "ResponseError" &&
  error.reason.status === 200 &&
  // A missing pull ref can come along; the retried read tolerates it.
  error.reason.errors.every((graphQlError) => {
    const { path, type } = graphQlError;
    return (
      isMissingPullRef(graphQlError) ||
      (type === "FORBIDDEN" &&
        path?.length === 6 &&
        path[0] === "repository" &&
        path[1] === "pullRequest" &&
        path[2] === "reviewRequests" &&
        path[3] === "nodes" &&
        typeof path[4] === "number" &&
        Number.isInteger(path[4]) &&
        path[4] >= 0 &&
        path[5] === "requestedReviewer")
    );
  });

const isMissingPullRefOnly = <E>(
  error: E,
): error is E &
  GraphQLClientError.GraphQLClientError & { readonly reason: GraphQLClientError.ResponseError } =>
  isGraphQlClientError(error) &&
  error.reason._tag === "ResponseError" &&
  error.reason.status === 200 &&
  error.reason.errors.every(isMissingPullRef);

/**
 * GitHub can lack `refs/pull/<number>/head` for a pull request it otherwise answers, and then
 * fails only the comparison against it. The rest of that answer stands, its comparison unknown.
 */
const toleratingMissingPullRef =
  <A, R2>(decode: (data: unknown) => Effect.Effect<A, Schema.SchemaError, R2>) =>
  <E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchIf(isMissingPullRefOnly, (error) =>
        decode(error.reason.data).pipe(Effect.mapError(() => error)),
      ),
    );

export const toleratingMissingPullRefInCore = toleratingMissingPullRef(
  Schema.decodeUnknownEffect(PullRequestCore.result),
);
export const toleratingMissingPullRefInActionState = toleratingMissingPullRef(
  Schema.decodeUnknownEffect(PullRequestActionState.result),
);
