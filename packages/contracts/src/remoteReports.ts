import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";

export const REMOTE_REPORT_SUMMARY_MAX_CHARS = 4000;
export const RemoteReportKind = Schema.Literals(["progress", "completed", "failed", "needs_input"]);
export type RemoteReportKind = typeof RemoteReportKind.Type;
export const RemoteReportDeliveryMode = Schema.Literals(["notify_only", "next_turn", "wake"]);
export type RemoteReportDeliveryMode = typeof RemoteReportDeliveryMode.Type;
const HexKey = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const CorrelationId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const Summary = Schema.String.check(Schema.isMaxLength(REMOTE_REPORT_SUMMARY_MAX_CHARS));
export const RemoteReportBindingInput = Schema.Struct({
  correlationId: CorrelationId,
  originLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  originThreadId: ThreadId,
  readKeyHash: HexKey,
});
export type RemoteReportBindingInput = typeof RemoteReportBindingInput.Type;
export const RemoteReport = Schema.Struct({
  sequence: NonNegativeInt,
  runId: Schema.NullOr(RunId),
  kind: RemoteReportKind,
  summary: Summary,
  createdAt: IsoDateTime,
});
export type RemoteReport = typeof RemoteReport.Type;
export const RemoteOriginReportInput = Schema.Struct({
  status: RemoteReportKind,
  summary: Summary,
});
export type RemoteOriginReportInput = typeof RemoteOriginReportInput.Type;
export const RemoteOriginReportResult = Schema.Struct({ sequence: NonNegativeInt });
export type RemoteOriginReportResult = typeof RemoteOriginReportResult.Type;
/**
 * What still holds a finished run's thread open: provider background work and a
 * restart continuation still to come. Present only for a terminal run; an older
 * GOAT omits it, so an origin that settles on it must treat absence as unknown.
 */
export const RemoteRunHolds = Schema.Struct({
  backgroundTasks: NonNegativeInt,
  continuationPending: Schema.Boolean,
});
export type RemoteRunHolds = typeof RemoteRunHolds.Type;
export const RemoteObservedRun = Schema.Struct({
  runId: RunId,
  status: OrchestrationV2RunStatus,
  summary: Schema.NullOr(Summary),
  /** Pending user-input questions on this run. An older GOAT omits it. */
  pendingRequestIds: Schema.optional(Schema.Array(RuntimeRequestId)),
  holds: Schema.optional(RemoteRunHolds),
});
export type RemoteObservedRun = typeof RemoteObservedRun.Type;
/**
 * The caller's last view of the observed run. A wait releases when the run, its
 * status, or (when the caller sends them) its questions or holds differ from it.
 */
export const RemoteKnownRun = Schema.Struct({
  runId: RunId,
  status: Schema.String,
  pendingRequestIds: Schema.optional(Schema.Array(RuntimeRequestId)),
  holds: Schema.optional(RemoteRunHolds),
});
export type RemoteKnownRun = typeof RemoteKnownRun.Type;
export const RemoteOriginReportsWaitInput = Schema.Struct({
  correlationId: CorrelationId,
  readKey: HexKey,
  afterSequence: NonNegativeInt,
  watchRunId: Schema.NullOr(RunId),
  knownRun: Schema.NullOr(RemoteKnownRun),
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600000 })),
});
export type RemoteOriginReportsWaitInput = typeof RemoteOriginReportsWaitInput.Type;
export const RemoteOriginReportsWaitResult = Schema.Struct({
  threadId: ThreadId,
  reports: Schema.Array(RemoteReport),
  hasMore: Schema.Boolean,
  observedRun: Schema.NullOr(RemoteObservedRun),
  latestRunId: Schema.NullOr(RunId),
  timedOut: Schema.Boolean,
});
export type RemoteOriginReportsWaitResult = typeof RemoteOriginReportsWaitResult.Type;

export const RemoteDispatchState = Schema.Literals([
  "launching",
  "running",
  "idle",
  "settled",
  "cancelled",
  "lost",
]);
export type RemoteDispatchState = typeof RemoteDispatchState.Type;
export const RemoteDispatchView = Schema.Struct({
  correlationId: Schema.String,
  host: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["thread", "task"]),
  delivery: RemoteReportDeliveryMode,
  state: RemoteDispatchState,
  reportsSupported: Schema.Boolean,
  latest: Schema.NullOr(
    Schema.Struct({
      kind: RemoteReportKind,
      summary: Schema.String,
      at: IsoDateTime,
    }),
  ),
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type RemoteDispatchView = typeof RemoteDispatchView.Type;

/**
 * A thread this environment started or watches on another machine over SSH,
 * from its remote dispatch records and launch watches. `host` is the SSH alias
 * on this environment, so another client resolves the thread by `threadId`
 * among the environments it is connected to.
 */
export const RemoteLaunch = Schema.Struct({
  host: Schema.String,
  /** Null while the launch is in flight, or when its outcome was lost. */
  threadId: Schema.NullOr(ThreadId),
  title: Schema.NullOr(Schema.String),
  /** The thread in this environment that launched or watches it. */
  launcherThreadId: ThreadId,
  /** `watch` is a launch watch with no dispatch record, such as goat_thread_watch. */
  source: Schema.Literals(["thread", "task", "watch"]),
  state: Schema.NullOr(RemoteDispatchState),
  latest: RemoteDispatchView.fields.latest,
  hostUnavailableSince: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type RemoteLaunch = typeof RemoteLaunch.Type;

export const REMOTE_LAUNCHES_DEFAULT_LIMIT = 100;
export const RemoteLaunchesListInput = Schema.Struct({
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
export type RemoteLaunchesListInput = typeof RemoteLaunchesListInput.Type;
export const RemoteLaunchesListResult = Schema.Struct({
  /** Newest first. */
  launches: Schema.Array(RemoteLaunch),
  truncated: Schema.Boolean,
});
export type RemoteLaunchesListResult = typeof RemoteLaunchesListResult.Type;
export class RemoteLaunchesError extends Schema.TaggedError<RemoteLaunchesError>()(
  "RemoteLaunchesError",
  { message: Schema.String },
) {}
