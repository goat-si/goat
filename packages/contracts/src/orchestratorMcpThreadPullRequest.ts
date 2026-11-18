import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PullRequestState } from "./pullRequest.ts";
import { ThreadPullRequestKey, ThreadPullRequestLinkSource } from "./threadPullRequest.ts";

/** state is null until the host is read. */
export const OrchestratorMcpThreadPullRequest = Schema.Struct({
  ...ThreadPullRequestKey.fields,
  url: TrimmedNonEmptyString,
  source: ThreadPullRequestLinkSource,
  state: Schema.NullOr(PullRequestState),
  /** Optional, unlike upstream: a CLI or another host may read an older server that omits them. */
  watching: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "True for any watch, including one GOAT started by itself; such an automatic watch wakes the agent but never holds the thread while checks run. To follow a pull request when asked, call goat_pull_request_watch even when this is true.",
    }),
  ),
  watchStartedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type OrchestratorMcpThreadPullRequest = typeof OrchestratorMcpThreadPullRequest.Type;
