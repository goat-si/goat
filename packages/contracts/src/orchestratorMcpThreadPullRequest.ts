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
  watching: Schema.optional(Schema.Boolean),
  watchStartedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type OrchestratorMcpThreadPullRequest = typeof OrchestratorMcpThreadPullRequest.Type;
