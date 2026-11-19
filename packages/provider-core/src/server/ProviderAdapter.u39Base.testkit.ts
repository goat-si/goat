import {
  OrchestrationV2AppThread,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ExecutionNode,
  OrchestrationV2Subagent,
  OrchestrationV2ConversationMessage,
  OrchestrationV2TurnItem,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRetry,
  ProviderDriverKind,
  ThreadId,
  RuntimeRequestId,
  RunId,
  MessageId,
  ProviderTurnId,
  TurnItemId,
  ProviderThreadId,
  PositiveInt,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

export const ProviderAdapterV2Event = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("app_thread.created"),
    driver: ProviderDriverKind,
    appThread: OrchestrationV2AppThread,
    createOnly: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("provider_session.updated"),
    driver: ProviderDriverKind,
    providerSession: OrchestrationV2ProviderSession,
  }),
  Schema.Struct({
    type: Schema.Literal("provider_thread.updated"),
    driver: ProviderDriverKind,
    providerThread: OrchestrationV2ProviderThread,
    /** Work remaining at this point in the event stream, including native continuations. */
    pendingBackgroundWork: Schema.optional(Schema.Boolean),
    /** Persist idle background snapshots before a run subscriber exists. */
    sessionScoped: Schema.optional(Schema.Boolean),
    retainedNativeTurnIds: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("provider_turn.updated"),
    driver: ProviderDriverKind,
    threadId: Schema.optional(ThreadId),
    providerTurn: OrchestrationV2ProviderTurn,
    retainedRuntimeRequestIds: Schema.optional(Schema.Array(RuntimeRequestId)),
  }),
  Schema.Struct({
    type: Schema.Literal("node.updated"),
    planUpdateRunId: Schema.optionalKey(RunId),
    driver: ProviderDriverKind,
    node: OrchestrationV2ExecutionNode,
    sessionScoped: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("subagent.updated"),
    driver: ProviderDriverKind,
    subagent: OrchestrationV2Subagent,
    sessionScoped: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("message.updated"),
    driver: ProviderDriverKind,
    message: OrchestrationV2ConversationMessage,
  }),
  Schema.Struct({
    type: Schema.Literal("turn_item.updated"),
    planUpdateRunId: Schema.optionalKey(RunId),
    driver: ProviderDriverKind,
    turnItem: OrchestrationV2TurnItem,
    /** Persist recovered activity independently of a run subscription. */
    sessionScoped: Schema.optional(Schema.Boolean),
  }),
  /** A steer the provider queued stays `pending` until the agent reads it; `cancelled` if dropped unread. */
  Schema.Struct({
    type: Schema.Literal("steer.updated"),
    driver: ProviderDriverKind,
    threadId: ThreadId,
    runId: RunId,
    messageId: MessageId,
    status: Schema.Literals(["pending", "completed", "cancelled"]),
  }),
  // Start before the root terminal; clear only after the final covered projection.
  // Consumer lifetime cannot depend on a producer probe that runs ahead of its queue.
  Schema.Struct({
    type: Schema.Literal("background_work.updated"),
    driver: ProviderDriverKind,
    providerTurnId: ProviderTurnId,
    pending: Schema.Boolean,
  }),
  /** Unpersisted deltas go only to clients showing the row; final output arrives in turn_item.updated. */
  Schema.Struct({
    type: Schema.Literal("command_output.delta"),
    driver: ProviderDriverKind,
    threadId: ThreadId,
    itemId: TurnItemId,
    chunk: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("runtime_request.updated"),
    driver: ProviderDriverKind,
    threadId: Schema.optional(ThreadId),
    runtimeRequest: OrchestrationV2RuntimeRequest,
  }),
  Schema.Struct({
    type: Schema.Literal("plan.updated"),
    planUpdateRunId: Schema.optionalKey(RunId),
    driver: ProviderDriverKind,
    plan: OrchestrationV2PlanArtifact,
  }),
  Schema.Struct({
    type: Schema.Literal("turn.terminal"),
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    runOrdinal: PositiveInt,
    status: Schema.Literals(["completed", "interrupted", "cancelled"]),
    failure: Schema.Null,
    reason: Schema.optional(Schema.String),
    threadDisposition: Schema.Literals(["reusable", "broken"]),
    /** The full result a cloud task reported, when its saved summary is shortened. */
    resultText: Schema.optional(Schema.String),
    retainedRuntimeRequestIds: Schema.optional(Schema.Array(RuntimeRequestId)),
  }),
  Schema.Struct({
    type: Schema.Literal("turn.terminal"),
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    runOrdinal: PositiveInt,
    failureItemOrdinal: PositiveInt,
    status: Schema.Literal("failed"),
    failure: OrchestrationV2ProviderFailure,
    retry: Schema.optional(OrchestrationV2ProviderRetry),
    retryStartedAt: Schema.optional(Schema.DateTimeUtc),
    threadDisposition: Schema.Literals(["reusable", "broken"]),
    /** Child turns outlive root failure and report their own terminals; otherwise open children settle. */
    childTurnsContinue: Schema.optional(Schema.Literal(true)),
    retainedRuntimeRequestIds: Schema.optional(Schema.Array(RuntimeRequestId)),
  }),
]);
