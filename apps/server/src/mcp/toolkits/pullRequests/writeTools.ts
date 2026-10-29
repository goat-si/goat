import {
  PullRequestActionInput,
  PullRequestCommentInput,
  PullRequestCommentUpdateInput,
  PullRequestLabelChangeInput,
  PullRequestMergeMethod,
  PullRequestReactionInput,
  PullRequestReviewerRequestInput,
  PullRequestSubmitReviewInput,
  PullRequestThreadReplyInput,
  PullRequestThreadResolutionInput,
  PullRequestUpdateInput,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";

import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PullRequests from "../../../pullRequest/PullRequestService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import { withClientRequestId } from "../keyedParameters.ts";
import type { PullRequestTargetInput, PullRequestToolError } from "./tools.ts";

export class PullRequestWriteFailedError extends Schema.TaggedError<PullRequestWriteFailedError>()(
  "PullRequestWriteFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The pull request write failed and may have been partly posted. Read pull_request.activity or pull_request.read to reconcile. Never resend with a new key. Tell the user if the outcome cannot be confirmed.";
  }
}

/** Refused before any request reached the host, so nothing was posted and the same call may run again. */
export class PullRequestWriteRefusedError extends Schema.TaggedError<PullRequestWriteRefusedError>()(
  "PullRequestWriteRefusedError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const Receipt = Schema.Struct({
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  url: Schema.String,
  status: Schema.Literal("accepted"),
});
type WriteVerb =
  | "update"
  | "comment"
  | "comment_update"
  | "review_submit"
  | "thread_reply"
  | "thread_resolve"
  | "react"
  | "labels"
  | "reviewers"
  | "action"
  | "merge"
  | "close";

export const makeWriteTools = (
  target: Pick<typeof PullRequestTargetInput.fields, "url" | "repository" | "number" | "host">,
  failure: typeof PullRequestToolError,
) => {
  const make = <const Verb extends WriteVerb, Fields extends Schema.Struct.Fields>(
    verb: Verb,
    fields: Fields,
  ) => {
    const entry = agentSurfaceRegistry[`pull_request.${verb}`];
    return Tool.make(`goat_pull_request_${verb}` as const, {
      description: entry.description,
      parameters: withClientRequestId(Schema.Struct({ ...target, ...fields })),
      success: Receipt,
      failure,
      dependencies: [
        McpInvocationContext.McpInvocationContext,
        Threads.ThreadManagementService,
        PullRequests.PullRequestService,
      ],
    }).annotateMerge(agentSurfaceAnnotations(entry));
  };
  return [
    make("update", {
      title: PullRequestUpdateInput.fields.title,
      body: PullRequestUpdateInput.fields.body,
    }),
    make("comment", { body: PullRequestCommentInput.fields.body }),
    make("comment_update", {
      commentId: PullRequestCommentUpdateInput.fields.commentId,
      kind: PullRequestCommentUpdateInput.fields.kind,
      body: PullRequestCommentUpdateInput.fields.body,
    }),
    make("review_submit", {
      verdict: PullRequestSubmitReviewInput.fields.verdict,
      body: PullRequestSubmitReviewInput.fields.body,
      comments: PullRequestSubmitReviewInput.fields.comments,
    }),
    make("thread_reply", {
      threadId: PullRequestThreadReplyInput.fields.threadId,
      body: PullRequestThreadReplyInput.fields.body,
    }),
    make("thread_resolve", {
      threadId: PullRequestThreadResolutionInput.fields.threadId,
      resolved: PullRequestThreadResolutionInput.fields.resolved,
    }),
    make("react", {
      subjectId: PullRequestReactionInput.fields.subjectId,
      content: PullRequestReactionInput.fields.content,
      reacted: PullRequestReactionInput.fields.reacted,
    }),
    make("labels", {
      labels: PullRequestLabelChangeInput.fields.labels,
      applied: PullRequestLabelChangeInput.fields.applied,
    }),
    make("reviewers", {
      reviewers: PullRequestReviewerRequestInput.fields.reviewers,
      requested: PullRequestReviewerRequestInput.fields.requested,
    }),
    make("action", {
      action: Schema.Literals(["ready", "draft", "reopen", "update-branch", "disable-auto-merge"]),
      updateMethod: PullRequestActionInput.fields.updateMethod,
    }),
    make("merge", {
      method: Schema.optional(PullRequestMergeMethod),
      auto: Schema.optional(Schema.Boolean),
      headSha: PullRequestActionInput.fields.headSha.annotate({
        description:
          "Reviewed head SHA from pull_request.read; direct merges only, not auto:true or a merge queue.",
      }),
    }),
    make("close", {}),
  ] as const;
};
