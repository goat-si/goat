import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PullRequestState } from "./pullRequest.ts";
import { ThreadPullRequestKey, ThreadPullRequestLinkSource } from "./threadPullRequest.ts";

/** state is null until the host is read. */
export const OrchestratorMcpThreadPullRequest = Schema.Struct({
  ...ThreadPullRequestKey.fields,
  url: TrimmedNonEmptyString,
  source: ThreadPullRequestLinkSource,
  state: Schema.NullOr(PullRequestState),
});
export type OrchestratorMcpThreadPullRequest = typeof OrchestratorMcpThreadPullRequest.Type;
