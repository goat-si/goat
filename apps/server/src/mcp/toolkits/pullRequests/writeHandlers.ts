import {
  OrchestratorMcpFailure,
  type PullRequestActionInput,
  type PullRequestRef,
  type ThreadPullRequestKey,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as Sync from "../../../orchestration-v2/PullRequestSyncReactor.ts";
import * as PullRequests from "../../../pullRequest/PullRequestService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, reauthorizationFailure } from "../../threadAccess.ts";
import type { PullRequestTargetInput, PullRequestToolError, PullRequestsToolkit } from "./tools.ts";
import { PullRequestWriteFailedError, PullRequestWriteRefusedError } from "./writeTools.ts";

/**
 * The service's own checks fail before any host request and carry no host cause. Any host error
 * may follow an earlier request of the same write (GitLab posts a review in several), so it stays
 * an unknown outcome.
 */
const classified = (error: PullRequests.PullRequestError, natural = false) =>
  error.cause === undefined
    ? new PullRequestWriteRefusedError({ detail: error.message })
    : new PullRequestWriteFailedError({ cause: error, ...(natural ? { natural: true } : {}) });

const prWriteGate = Effect.fn("PullRequestsToolkit.prWriteGate")(function* () {
  const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
  const { limits } = yield* loadCaller();
  if (scope.readOnly || limits.interactionMode === "plan")
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Pull request writes need a writable credential and a thread in default interaction mode.",
    });
  if (scope.thread !== undefined) return;
  if (
    scope.client === undefined ||
    !scope.grantedScopes?.includes("source-control:write") ||
    scope.reauthorize === undefined
  )
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Outside MCP clients need source-control:write and live reauthorization for pull request writes.",
    });
  yield* scope.reauthorize(["source-control:write"]).pipe(Effect.mapError(reauthorizationFailure));
});

type Target = Omit<PullRequestTargetInput, "threadId">;
type Located = {
  readonly target: ThreadPullRequestKey & { readonly url: string };
  readonly ref: PullRequestRef & { readonly host: string };
};
type WriteHandlers = Pick<
  McpToolAccess.Handlers<typeof PullRequestsToolkit.tools>,
  `goat_pull_request_${"update" | "comment" | "comment_update" | "review_submit" | "thread_reply" | "thread_resolve" | "react" | "labels" | "reviewers" | "action" | "merge" | "close" | "branch_delete"}`
>;

export const makeWriteHandlers = Effect.fn("PullRequestsToolkit.makeWriteHandlers")(function* (
  locateOne: (
    input: Target,
  ) => Effect.Effect<Located, PullRequestToolError, McpInvocationContext.McpInvocationContext>,
) {
  const service = yield* PullRequests.PullRequestService;
  const sync = yield* Sync.PullRequestSyncReactor;
  const write = <P extends Target>(
    handle: (input: P, ref: Located["ref"]) => Effect.Effect<void, PullRequests.PullRequestError>,
    natural = false,
  ) =>
    McpToolAccess.writesWithCapability(
      (input: P) =>
        Effect.gen(function* () {
          yield* prWriteGate();
          const { target, ref } = yield* locateOne(input);
          yield* McpToolAccess.admit(input);
          yield* handle(input, ref).pipe(Effect.mapError((error) => classified(error, natural)));
          return { ...target, status: "accepted" as const };
        }),
      { admission: "handler" },
    );
  const action = (ref: Located["ref"], input: Omit<PullRequestActionInput, keyof PullRequestRef>) =>
    service
      .runAction({ ...ref, ...input })
      .pipe(
        Effect.tap(() =>
          sync.requestSync({ host: ref.host, repository: ref.repository, number: ref.number }),
        ),
      );

  return {
    goat_pull_request_update: write(({ title, body }, ref) =>
      service.update({
        ...ref,
        ...(title === undefined ? {} : { title }),
        ...(body === undefined ? {} : { body }),
      }),
    ),
    goat_pull_request_comment: write(({ body }, ref) => service.comment({ ...ref, body })),
    goat_pull_request_comment_update: write(({ commentId, kind, body }, ref) =>
      service.updateComment({ ...ref, commentId, kind, body }),
    ),
    goat_pull_request_review_submit: write(({ verdict, body, comments }, ref) =>
      service.submitReview({ ...ref, verdict, body, comments }),
    ),
    goat_pull_request_thread_reply: write(({ threadId, body }, ref) =>
      service.replyToThread({ ...ref, threadId, body }),
    ),
    goat_pull_request_thread_resolve: write(({ threadId, resolved }, ref) =>
      service.setThreadResolution({ ...ref, threadId, resolved }),
    ),
    goat_pull_request_react: write(({ subjectId, content, reacted }, ref) =>
      service.setReaction({
        ...ref,
        ...(subjectId === undefined ? {} : { subjectId }),
        content,
        reacted,
      }),
    ),
    goat_pull_request_labels: write(({ labels, applied }, ref) =>
      service.setLabels({ ...ref, labels, applied }),
    ),
    goat_pull_request_reviewers: write(({ reviewers, requested }, ref) =>
      service.requestReviewers({ ...ref, reviewers, requested }),
    ),
    goat_pull_request_action: write(({ action: requested, updateMethod }, ref) =>
      action(ref, { action: requested, ...(updateMethod === undefined ? {} : { updateMethod }) }),
    ),
    goat_pull_request_merge: write(({ method, auto, headSha }, ref) =>
      action(ref, {
        action: auto ? "enable-auto-merge" : "merge",
        ...(method === undefined ? {} : { mergeMethod: method }),
        ...(headSha === undefined ? {} : { headSha }),
      }),
    ),
    goat_pull_request_close: write((_, ref) => action(ref, { action: "close" })),
    goat_pull_request_branch_delete: write(
      (_, ref) => action(ref, { action: "delete-branch" }),
      true,
    ),
  } satisfies WriteHandlers;
});
