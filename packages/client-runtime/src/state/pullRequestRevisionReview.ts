import {
  PullRequestOperationError,
  WS_METHODS,
  type EnvironmentId,
  type PullRequestSubmitReviewInput,
  type ServerConfig,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { environmentConnectionAtoms } from "./environmentConnections.ts";
import { currentSession, requestInSession } from "../rpc/client.ts";

export const REVISION_REVIEW_UNAVAILABLE =
  "This connection cannot submit review comments at a specific revision.";

const supportsRevisionReview = (config: ServerConfig) =>
  config.environment.capabilities.revisionBoundPullRequestReviews === true;

export function createRevisionReviewSupportedAtom<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const connections = environmentConnectionAtoms(runtime);
  const activeSession = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const connection = Option.getOrNull(AsyncResult.value(get(connections(environmentId))));
      return connection?.[0].phase === "connected" ? Option.getOrNull(connection[1]) : null;
    }),
  );
  const supportedSession = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom((get) => {
      const session = get(activeSession(environmentId));
      return session === null
        ? Effect.succeed(null)
        : session.initialConfig.pipe(
            Effect.map((config) => (supportsRevisionReview(config) ? session : null)),
          );
    }),
  );
  return Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const session = get(activeSession(environmentId));
      const result = get(supportedSession(environmentId));
      // Initial config may still be loading after a reconnect. An old answer cannot grant access.
      return session !== null && result._tag === "Success" && session === result.value;
    }),
  );
}

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
    if (!supportsRevisionReview(config)) {
      return yield* new PullRequestOperationError({
        operation: "submitReview",
        detail: REVISION_REVIEW_UNAVAILABLE,
      });
    }
    return yield* requestInSession(session, WS_METHODS.pullRequestsSubmitReview, input);
  },
);
