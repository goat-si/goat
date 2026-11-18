import {
  PullRequestOperationError,
  WS_METHODS,
  type PullRequestSubmitReviewInput,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import { currentSession, requestInSession } from "../rpc/client.ts";

export const submitRevisionBoundReview = Effect.fn("PullRequests.submitRevisionBoundReview")(
  function* (input: PullRequestSubmitReviewInput) {
    const session = yield* currentSession();
    const config = yield* session.initialConfig.pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestOperationError({
            operation: "submitReview",
            detail: "Could not verify revision checks on this connection.",
            cause,
          }),
      ),
    );
    if (config.environment.capabilities.revisionBoundPullRequestReviews !== true) {
      return yield* new PullRequestOperationError({
        operation: "submitReview",
        detail: "This connection cannot submit review comments at a specific revision.",
      });
    }
    return yield* requestInSession(session, WS_METHODS.pullRequestsSubmitReview, input);
  },
);
