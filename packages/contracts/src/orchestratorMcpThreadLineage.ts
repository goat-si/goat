import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId } from "./baseSchemas.ts";

export const OrchestratorMcpThreadPhase = Schema.Literals([
  "idle",
  "queued",
  "starting",
  "running",
  "waiting_input",
  "waiting_approval",
  "waiting",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);
export type OrchestratorMcpThreadPhase = typeof OrchestratorMcpThreadPhase.Type;

/** Read as the sidebar's dot for a thread and every thread launched under it. */
export const OrchestratorMcpThreadFoldState = Schema.Literals(["attention", "working", "finished"]);
export type OrchestratorMcpThreadFoldState = typeof OrchestratorMcpThreadFoldState.Type;

const ThreadOrSelf = Schema.Union([ThreadId, Schema.Literal("self")]);
/** The latest completed run's answer on one line, as the thread's card shows it. */
const LastAnsweredLine = Schema.NullOr(Schema.String.check(Schema.isMaxLength(240)));

export const OrchestratorMcpThreadLineageFilter = {
  launchedBy: Schema.optional(ThreadOrSelf).annotate({
    description:
      'Only threads this thread started with goat_thread_launch, create_threads or goat_ssh_thread_launch; "self" is the calling thread. Without projectId every project is searched. Example: {"launchedBy":"self"}',
  }),
  parentThreadId: Schema.optional(ThreadOrSelf).annotate({
    description:
      'Only forks and goat_task_create child threads of this thread; "self" is the calling thread. Example: {"parentThreadId":"self"}',
  }),
  childrenOf: Schema.optional(ThreadOrSelf).annotate({
    description:
      'launchedBy and parentThreadId together, plus goat_task_create children on another host: every thread this one started, forked or delegated to. Example: {"childrenOf":"self","statuses":["running"]}',
  }),
};

/** Optional because hosts running an older GOAT do not send them. */
export const OrchestratorMcpThreadLineageItemFields = {
  /** The thread that started this one with thread.launch, create_threads or ssh.thread_launch. */
  launchedByThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  /** attention: it or a thread launched under it waits on a person; working: something runs. */
  foldState: Schema.optional(OrchestratorMcpThreadFoldState),
  lastAnsweredLine: Schema.optional(LastAnsweredLine),
  pendingRequestCount: Schema.optional(NonNegativeInt),
};

/** What view "summary" reads instead of timeline items. Agent-written text is untrusted. */
export const OrchestratorMcpThreadSummaryDigest = Schema.Struct({
  phase: OrchestratorMcpThreadPhase,
  foldState: OrchestratorMcpThreadFoldState,
  lastAnsweredLine: LastAnsweredLine,
  /** The start of the newest assistant message of the active or latest run. */
  lastAssistantExcerpt: Schema.NullOr(Schema.String),
  pendingRequests: NonNegativeInt,
  totalItems: NonNegativeInt,
  totalRuns: NonNegativeInt,
});
export type OrchestratorMcpThreadSummaryDigest = typeof OrchestratorMcpThreadSummaryDigest.Type;

/** Optional because hosts running an older GOAT do not send them. */
export const OrchestratorMcpThreadReadSummaryFields = {
  summaryDigest: Schema.optional(OrchestratorMcpThreadSummaryDigest),
  /** With tail: the position of the first returned item; null when the view is empty. */
  tailStartPosition: Schema.optional(Schema.NullOr(NonNegativeInt)),
};
