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
import { ThreadResultOutcome } from "./threadResult.ts";
import { TurnCapability } from "./composerContext.ts";
import { ChannelWorkerObservation } from "./channelWorkerObservation.ts";

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
  /**
   * The origin relays this thread's goat_thread_send to hosts the thread cannot
   * reach. Only an origin that reads relay reports sets it; an older remote drops it.
   */
  relaySend: Schema.optional(Schema.Boolean),
  /**
   * The origin also delivers a relayed send's turn capabilities. Without it a relay that asks
   * for them is refused instead of losing them on the way.
   */
  relayCapabilities: Schema.optional(Schema.Boolean),
});
export type RemoteReportBindingInput = typeof RemoteReportBindingInput.Type;
/** A goat_thread_send the remote thread asked its origin to deliver on its behalf. */
export const RemoteRelaySend = Schema.Struct({
  host: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  threadId: ThreadId,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)),
  mode: Schema.optional(Schema.Literals(["auto", "queue", "steer", "restart"])),
  /** The turn capabilities the send asked for; an older origin drops them. */
  capabilities: Schema.optional(Schema.Array(TurnCapability)),
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type RemoteRelaySend = typeof RemoteRelaySend.Type;
export const RemoteReport = Schema.Struct({
  sequence: NonNegativeInt,
  runId: Schema.NullOr(RunId),
  kind: RemoteReportKind,
  summary: Summary,
  createdAt: IsoDateTime,
  /** Present only for a binding with relaySend; the origin delivers it instead of quoting it. */
  relay: Schema.optional(RemoteRelaySend),
});
export type RemoteReport = typeof RemoteReport.Type;
export const RemoteOriginReportInput = Schema.Struct({
  status: RemoteReportKind,
  summary: Summary,
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))).annotate({
    description:
      "Idempotency key. A repeat with the same key and report returns the first receipt without reporting again; the same key with another report is refused. Use a new key for each new report.",
  }),
});
export type RemoteOriginReportInput = typeof RemoteOriginReportInput.Type;
export const RemoteOriginReportResult = Schema.Struct({
  sequence: NonNegativeInt,
  /**
   * `launcher`: the thread has no origin binding, so the report went to the thread that
   * launched it on this machine. Absent when it went to the origin.
   */
  delivery: Schema.optional(Schema.Literal("launcher")),
});
export type RemoteOriginReportResult = typeof RemoteOriginReportResult.Type;
export const RemoteOriginReportReceiptInput = Schema.Struct({
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type RemoteOriginReportReceiptInput = typeof RemoteOriginReportReceiptInput.Type;
/** A keyed report this thread made. It outlives the origin's acknowledgement and the inbox. */
export const RemoteOriginReportReceipt = Schema.Struct({
  clientRequestId: TrimmedNonEmptyString,
  status: RemoteReportKind,
  sequence: NonNegativeInt,
  delivery: Schema.Literals(["origin", "launcher"]),
  /**
   * False only for a launcher wake that was recorded but not yet confirmed sent. Repeating the
   * report with the same clientRequestId sends it at most once.
   */
  delivered: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type RemoteOriginReportReceipt = typeof RemoteOriginReportReceipt.Type;
export const RemoteOriginReportReceiptResult = Schema.Struct({
  receipt: Schema.NullOr(RemoteOriginReportReceipt),
});
export type RemoteOriginReportReceiptResult = typeof RemoteOriginReportReceiptResult.Type;
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
/**
 * What the worker reported about a terminal run with goat_thread_report_result. Absent when
 * it did not report, and from an older GOAT, which the origin reads as "no report".
 */
export const RemoteReportedOutcome = Schema.Struct({
  outcome: ThreadResultOutcome,
  summary: Schema.optional(Summary),
});
export type RemoteReportedOutcome = typeof RemoteReportedOutcome.Type;
export const RemoteObservedRun = Schema.Struct({
  runId: RunId,
  status: OrchestrationV2RunStatus,
  summary: Schema.NullOr(Summary),
  /** Pending user-input questions on this run. An older GOAT omits it. */
  pendingRequestIds: Schema.optional(Schema.Array(RuntimeRequestId)),
  holds: Schema.optional(RemoteRunHolds),
  reported: Schema.optional(RemoteReportedOutcome),
  /**
   * The worker thread's pull requests, pending native requests and usage-limit wait, read the
   * way the origin reads a local worker. An older GOAT omits it.
   */
  observation: Schema.optional(ChannelWorkerObservation),
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
  observation: Schema.optional(ChannelWorkerObservation),
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
/**
 * The origin asks the destination to settle a correlation whose launch outcome was lost:
 * return its binding and thread/run state, or durably fence the id so a late bind is
 * refused. The read key authorizes the caller; a fence remembers its hash.
 */
export const RemoteResolveBindingInput = Schema.Struct({
  correlationId: CorrelationId,
  readKey: HexKey,
});
export type RemoteResolveBindingInput = typeof RemoteResolveBindingInput.Type;
export const RemoteResolveBindingResult = Schema.Union([
  Schema.TaggedStruct("bound", {
    threadId: ThreadId,
    originThreadId: ThreadId,
    threadExists: Schema.Boolean,
    threadDeleted: Schema.Boolean,
    activeRunId: Schema.NullOr(RunId),
  }),
  Schema.TaggedStruct("fenced", {}),
]);
export type RemoteResolveBindingResult = typeof RemoteResolveBindingResult.Type;
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
