/**
 * ChannelLedger - durable state for channel input, tasks, and deliveries.
 *
 * One SQLite transaction commits an input with its decision, a task with its event, and the
 * outbox rows those changes need, so a crash never leaves a task without its event or a reply
 * without its delivery. Model calls, thread launches, and transport sends happen outside these
 * transactions, after commit.
 *
 * Background workers run in the one process that holds the worker ownership row. Their writes
 * pass that token and each transaction re-checks it first, so a process that lost ownership
 * (for example after being suspended past the heartbeat window) cannot commit a claim.
 *
 * @module ChannelLedger
 */
import {
  AuthEnvironmentScopes,
  type ChannelAnswerProjectChoice,
  ChannelBotRef,
  type ChannelConversationId,
  type ChannelDeliveryId,
  ChannelInboundMessage,
  type ChannelIngestResult,
  type ChannelInputId,
  type ChannelInputSnapshot,
  ChannelOutboundMessage,
  type ChannelReceptionId,
  ChannelReceptionResult,
  ChannelReplyAddress,
  ChannelRequester,
  ChannelTask,
  ChannelTaskEvent,
  ChannelTaskLedgerExportRow,
  ChannelWorkerRun,
  type ChannelTaskBrief,
  type ChannelTaskExportInput,
  type ChannelTaskExportResult,
  type ChannelTaskEventId,
  type ChannelTaskId,
  type ChannelTaskStatus,
  RuntimeMode,
  type ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class ChannelLedgerError extends Schema.TaggedError<ChannelLedgerError>()(
  "ChannelLedgerError",
  {
    reason: Schema.Literals([
      "persistence",
      "version_conflict",
      "idempotency_conflict",
      "ownership_lost",
    ]),
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Channel ledger " + this.reason + ": " + this.detail;
  }
}

/** A delivery to commit alongside a ledger change. `causeKey` makes a re-commit a no-op. */
export interface ChannelOutboxInsert {
  readonly deliveryId: ChannelDeliveryId;
  readonly causeKey: string;
  readonly message: ChannelOutboundMessage;
  readonly inputId?: ChannelInputId | undefined;
  readonly taskId?: ChannelTaskId | undefined;
}

export interface ChannelStoredInput {
  readonly ownerId: string;
  readonly snapshot: ChannelInputSnapshot;
  readonly message: ChannelInboundMessage;
  readonly requester: ChannelRequester | undefined;
  readonly decision: ChannelReceptionResult | undefined;
}

export interface ChannelStoredTask {
  readonly ownerId: string;
  readonly task: ChannelTask;
  readonly pendingAnswerMessageId: string | undefined;
  readonly completionHold: string | undefined;
}

export interface ChannelPendingEvent {
  readonly sequence: number;
  readonly event: ChannelTaskEvent;
}

export interface ChannelStoredDelivery {
  readonly deliveryId: ChannelDeliveryId;
  readonly message: ChannelOutboundMessage;
  readonly attempts: number;
}

export type ChannelDeliveryOutcome =
  | { readonly type: "delivered"; readonly externalMessageId?: string | undefined }
  | { readonly type: "retry"; readonly at: string; readonly errorCode: string }
  | { readonly type: "ambiguous"; readonly errorCode: string }
  | { readonly type: "failed"; readonly errorCode: string };

export interface ChannelTaskEventWrite {
  readonly next: ChannelTask;
  readonly expectedVersion: number;
  readonly event: ChannelTaskEvent;
  /** The reception service turns this event into words for the requester. */
  readonly narrate?: boolean | undefined;
  /** The dispatcher forwards this answer to the worker thread. */
  readonly forward?: boolean | undefined;
  /** Null clears the column; undefined leaves it. */
  readonly pendingAnswerMessageId?: string | null | undefined;
  readonly completionHold?: string | null | undefined;
}

export interface ChannelIdentity {
  readonly ownerId: string;
  readonly principalId: string;
  readonly displayName: string;
  readonly runtimeModeCeiling: RuntimeMode;
  readonly grantedScopes: AuthEnvironmentScopes;
}

export interface ChannelTailEntry {
  readonly inputId: ChannelInputId;
  readonly text: string;
  readonly receivedAt: string;
  readonly replyText: string | undefined;
}

export class ChannelLedger extends Context.Service<
  ChannelLedger,
  {
    /** Stores an input, or returns the stored one for the same idempotency key. */
    readonly acceptInput: (input: {
      readonly ownerId: string;
      readonly inputId: ChannelInputId;
      readonly conversationId: ChannelConversationId;
      readonly bindingId: string;
      readonly message: ChannelInboundMessage;
      readonly contentHash: string;
      /** Undefined stores the input as rejected. */
      readonly requester: ChannelRequester | undefined;
      readonly acceptedAt: string;
      /** Committed with a rejected input, such as a link notice for an unlinked account. */
      readonly rejectNotice?: ChannelOutboxInsert | undefined;
    }) => Effect.Effect<ChannelIngestResult, ChannelLedgerError>;
    readonly setTimelineSequence: (
      inputId: ChannelInputId,
      sequence: number,
    ) => Effect.Effect<void, ChannelLedgerError>;
    readonly getInput: (
      inputId: ChannelInputId,
    ) => Effect.Effect<ChannelStoredInput | undefined, ChannelLedgerError>;
    readonly listPendingInputs: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<ChannelInputId>, ChannelLedgerError>;
    /** Marks an input as being read. Returns nothing when it already finished. */
    readonly beginReception: (input: {
      readonly owner: string;
      readonly inputId: ChannelInputId;
      readonly receptionId: ChannelReceptionId;
      readonly readAt: string;
    }) => Effect.Effect<ChannelStoredInput | undefined, ChannelLedgerError>;
    /** Commits a reception's reply and decision. False when another pass owns the input. */
    readonly completeReception: (input: {
      readonly owner: string;
      readonly inputId: ChannelInputId;
      readonly receptionId: ChannelReceptionId;
      readonly replyText: string;
      readonly decision: ChannelReceptionResult;
      readonly createdTask?:
        | { readonly task: ChannelTask; readonly event: ChannelTaskEvent }
        | undefined;
      readonly taskEvents?: ReadonlyArray<ChannelTaskEventWrite> | undefined;
      readonly deliveries: ReadonlyArray<ChannelOutboxInsert>;
      readonly now: string;
    }) => Effect.Effect<boolean, ChannelLedgerError>;
    readonly failReception: (input: {
      readonly owner: string;
      readonly inputId: ChannelInputId;
      readonly receptionId: ChannelReceptionId;
      readonly failure: { readonly reason: string; readonly message: string };
      readonly deliveries: ReadonlyArray<ChannelOutboxInsert>;
      readonly now: string;
    }) => Effect.Effect<boolean, ChannelLedgerError>;
    /** Recent inputs and replies in one conversation, oldest first. */
    readonly readConversationTail: (
      conversationId: ChannelConversationId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<ChannelTailEntry>, ChannelLedgerError>;
    /**
     * Inputs in one conversation, accepted before `beforeInputId`, whose text or reply contains
     * `query`, newest first. The asking input and anything after it are never their own history.
     */
    readonly searchConversation: (
      conversationId: ChannelConversationId,
      query: string,
      limit: number,
      beforeInputId: ChannelInputId,
    ) => Effect.Effect<ReadonlyArray<ChannelTailEntry>, ChannelLedgerError>;
    readonly listConversationTasks: (
      conversationId: ChannelConversationId,
    ) => Effect.Effect<ReadonlyArray<ChannelTask>, ChannelLedgerError>;
    /**
     * Every running task in the conversation its worker shows as needing a person, however old:
     * an open approval must stay answerable past the recent-task window.
     */
    readonly listConversationNeedsYou: (
      conversationId: ChannelConversationId,
    ) => Effect.Effect<ReadonlyArray<ChannelTask>, ChannelLedgerError>;
    readonly getTask: (
      taskId: ChannelTaskId,
    ) => Effect.Effect<ChannelStoredTask | undefined, ChannelLedgerError>;
    readonly listTasks: (input: {
      readonly ownerId: string;
      readonly statuses?: ReadonlyArray<ChannelTaskStatus> | undefined;
      readonly limit: number;
      readonly cursor?: string | undefined;
    }) => Effect.Effect<
      { readonly tasks: ReadonlyArray<ChannelTask>; readonly nextCursor: string | undefined },
      ChannelLedgerError
    >;
    /** Most recently frozen brief, including earlier generations for version allocation. */
    readonly latestTaskBrief: (
      taskId: ChannelTaskId,
    ) => Effect.Effect<ChannelTaskBrief | undefined, ChannelLedgerError>;
    /** Ledger-only JSONL source rows, in terminal-event order; ChannelTaskExport adds thread evidence. */
    readonly exportTasks: (
      input: ChannelTaskExportInput & { readonly ownerId: string },
    ) => Effect.Effect<ChannelTaskExportResult, ChannelLedgerError>;
    /** Bounded forwarding provenance from the terminal event's generation only. */
    readonly answerEventIdsThrough: (
      taskId: ChannelTaskId,
      sequence: number,
    ) => Effect.Effect<
      { readonly eventIds: ReadonlyArray<ChannelTaskEventId>; readonly overflow: boolean },
      ChannelLedgerError
    >;
    readonly listTasksByStatus: (
      statuses: ReadonlyArray<ChannelTaskStatus>,
    ) => Effect.Effect<ReadonlyArray<ChannelStoredTask>, ChannelLedgerError>;
    /**
     * Tasks from any channel that wait on a person: an open question, or a running worker whose
     * thread needs an answer, approval, sign-in or resume (`observed.needsYou`). Each counts once.
     * With `readThrough`, a task counts only when it started waiting after that time.
     */
    readonly countWaitingTasks: (
      ownerId: string,
      readThrough?: string,
    ) => Effect.Effect<number, ChannelLedgerError>;
    readonly findTaskByWorkerThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ChannelStoredTask | undefined, ChannelLedgerError>;
    /**
     * Applies one task event with an expected-version check. `owner` fences worker writes;
     * `cursor` advances the worker-report cursor in the same transaction.
     */
    readonly applyTaskEvent: (input: {
      readonly owner?: string | undefined;
      readonly write: ChannelTaskEventWrite;
      readonly deliveries: ReadonlyArray<ChannelOutboxInsert>;
      readonly cursor?: number | undefined;
      /** Changes the task's remote worker state in the same transaction. */
      readonly remoteWorker?: RemoteWorkerStateUpdate | undefined;
    }) => Effect.Effect<number, ChannelLedgerError>;
    /** Marks why a finished run is not reported yet; the owner scan re-checks held tasks. */
    readonly setCompletionHold: (input: {
      readonly owner: string;
      readonly taskId: ChannelTaskId;
      readonly hold: string | null;
    }) => Effect.Effect<void, ChannelLedgerError>;
    readonly hasTaskEvent: (eventId: string) => Effect.Effect<boolean, ChannelLedgerError>;
    readonly listPendingNarrations: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<ChannelPendingEvent>, ChannelLedgerError>;
    readonly completeNarration: (input: {
      readonly owner: string;
      readonly sequence: number;
      readonly deliveries: ReadonlyArray<ChannelOutboxInsert>;
      readonly now: string;
    }) => Effect.Effect<void, ChannelLedgerError>;
    readonly listPendingForwards: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<ChannelPendingEvent>, ChannelLedgerError>;
    /**
     * Records one worker run as it stands now; the newest write for a run wins. Deliveries commit
     * in that same write, so a stall notice cannot land without the status it describes.
     */
    readonly upsertWorkerRun: (
      run: ChannelWorkerRun,
      deliveries?: ReadonlyArray<ChannelOutboxInsert>,
    ) => Effect.Effect<void, ChannelLedgerError>;
    /** The recorded runs of these tasks, oldest first per task. */
    readonly listWorkerRuns: (
      taskIds: ReadonlyArray<ChannelTaskId>,
    ) => Effect.Effect<ReadonlyArray<ChannelWorkerRun>, ChannelLedgerError>;
    /**
     * An owner's finished tasks whose newest outcome has not been delivered to where the work
     * came from: not written yet, still sending, given up, or unknown after a crash.
     */
    readonly listUndeliveredOutcomes: (
      ownerId: string,
    ) => Effect.Effect<ReadonlyArray<ChannelTask>, ChannelLedgerError>;
    /**
     * Local tasks claimed for a launch that finished since `since` and whose runs are not yet
     * all recorded as ended, newest first, at most `limit`.
     */
    readonly listUnsettledRunHistory: (input: {
      readonly since: string;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<ChannelTask>, ChannelLedgerError>;
    /** Marks a finished task's runs as all recorded as ended. */
    readonly settleRunHistory: (input: {
      readonly taskId: ChannelTaskId;
      readonly now: string;
    }) => Effect.Effect<void, ChannelLedgerError>;
    /** Which attempt a recorded stop is on; it starts at 0. */
    readonly stopAttempt: (eventId: string) => Effect.Effect<number, ChannelLedgerError>;
    /**
     * The code an approval card goes by in its conversation: "A1", "A2", … in the order cards were
     * first issued there, never reused, so a code names one request for good. Asking again for the
     * same request returns its code.
     */
    readonly issueApprovalCode: (input: {
      readonly conversationId: ChannelConversationId;
      readonly requestId: string;
      readonly now: string;
    }) => Effect.Effect<string, ChannelLedgerError>;
    /**
     * The code already issued for a request, and when. Does not issue a new one: a card that
     * was never sent has no code, so a numbered reply cannot land on it.
     */
    readonly approvalCodeForRequest: (
      requestId: string,
    ) => Effect.Effect<
      { readonly code: string; readonly issuedAt: string } | undefined,
      ChannelLedgerError
    >;
    /** The request a code was issued for in this conversation, if any. */
    readonly approvalRequestForCode: (input: {
      readonly conversationId: ChannelConversationId;
      readonly code: string;
    }) => Effect.Effect<string | undefined, ChannelLedgerError>;
    /** Moves a stop to its next attempt after the orchestrator refused the current one. */
    readonly advanceStopAttempt: (input: {
      readonly eventId: string;
      readonly from: number;
      readonly now: string;
    }) => Effect.Effect<void, ChannelLedgerError>;
    /** Recorded runs still running, waiting, or stalled, across tasks, for reconciliation. */
    readonly listOpenWorkerRuns: () => Effect.Effect<
      ReadonlyArray<ChannelWorkerRun>,
      ChannelLedgerError
    >;
    /**
     * How many of a person's tasks hold a worker now: dispatching, running, waiting on a person
     * with a worker, or stopped while the stop has not gone through. Questions asked before any
     * worker exists hold none.
     */
    readonly countBusyTasks: (input: {
      readonly ownerId: string;
      readonly principalId: string;
    }) => Effect.Effect<number, ChannelLedgerError>;
    /**
     * How each task's outcome (result, failure or stop) reached its requester: the delivery state
     * of the narration of the task's newest terminal event to where the work came from, or none
     * when that narration was not written yet.
     */
    readonly outcomeDeliveries: (
      taskIds: ReadonlyArray<ChannelTaskId>,
    ) => Effect.Effect<ReadonlyMap<string, string>, ChannelLedgerError>;
    /** Whether any recorded answer or follow-up for this task is still waiting to be sent. */
    readonly hasPendingForward: (
      taskId: ChannelTaskId,
    ) => Effect.Effect<boolean, ChannelLedgerError>;
    /** Whether a forward for this task was recorded before `sequence` and is still waiting. */
    readonly hasEarlierPendingForward: (input: {
      readonly taskId: ChannelTaskId;
      readonly sequence: number;
    }) => Effect.Effect<boolean, ChannelLedgerError>;
    readonly completeForward: (input: {
      readonly owner: string;
      readonly sequence: number;
    }) => Effect.Effect<void, ChannelLedgerError>;
    readonly enqueueDeliveries: (
      deliveries: ReadonlyArray<ChannelOutboxInsert>,
      now: string,
    ) => Effect.Effect<void, ChannelLedgerError>;
    /**
     * Marks the oldest due rows as delivering. A row waits while an earlier row for the same task
     * and destination kind is still pending or in flight, so a receipt goes out before its result.
     */
    readonly claimDueDeliveries: (input: {
      readonly owner: string;
      readonly now: string;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<ChannelStoredDelivery>, ChannelLedgerError>;
    readonly recordDelivery: (input: {
      readonly owner: string;
      readonly deliveryId: ChannelDeliveryId;
      readonly outcome: ChannelDeliveryOutcome;
      readonly now: string;
    }) => Effect.Effect<void, ChannelLedgerError>;
    /** After a restart: GOAT bot and MCP deliveries retry, external ones in flight become ambiguous. */
    readonly settleInterruptedDeliveries: (input: {
      readonly owner: string;
      readonly now: string;
    }) => Effect.Effect<void, ChannelLedgerError>;
    readonly getDeliveryState: (
      deliveryId: ChannelDeliveryId,
    ) => Effect.Effect<string | undefined, ChannelLedgerError>;
    /** Takes or keeps the worker ownership row. False while another live process holds it. */
    readonly claimOwnership: (input: {
      readonly token: string;
      readonly now: string;
      readonly staleBefore: string;
    }) => Effect.Effect<boolean, ChannelLedgerError>;
    readonly getWorkerCursor: () => Effect.Effect<number | undefined, ChannelLedgerError>;
    readonly getImessageCursor: (
      connectionId: string,
    ) => Effect.Effect<ImessageCursor | undefined, ChannelLedgerError>;
    readonly checkpointImessageCursor: (input: {
      readonly owner: string;
      readonly connectionId: string;
      readonly expected: ImessageCursor | undefined;
      readonly next: ImessageCursor;
      readonly now: string;
    }) => Effect.Effect<void, ChannelLedgerError>;
    /** Whether `owner` still holds the worker ownership row. */
    readonly isOwner: (owner: string) => Effect.Effect<boolean, ChannelLedgerError>;
    /** The task's remote worker state as stored JSON, if the task ever ran on another machine. */
    readonly getRemoteWorker: (
      taskId: ChannelTaskId,
    ) => Effect.Effect<string | undefined, ChannelLedgerError>;
    /**
     * The answers recorded in a task's current generation, newest first, which the dispatcher
     * reads when it asked. A retry starts over: earlier generations' answers are not returned.
     */
    readonly recentAnswers: (
      taskId: ChannelTaskId,
      limit: number,
    ) => Effect.Effect<
      ReadonlyArray<Extract<ChannelTaskEvent, { type: "task.question.answered" }>>,
      ChannelLedgerError
    >;
    /** Latest choice or unresolved answer in this generation; no-choice answers preserve it. */
    readonly rememberedProjectChoice: (
      taskId: ChannelTaskId,
    ) => Effect.Effect<ChannelAnswerProjectChoice | undefined, ChannelLedgerError>;
    /** Resolves an answer once, without changing its task version or delivery state. */
    readonly recordAnswerProjectChoice: (input: {
      readonly owner: string;
      readonly eventId: ChannelTaskEventId;
      readonly choice: ChannelAnswerProjectChoice;
    }) => Effect.Effect<void, ChannelLedgerError>;
    /** Reads, changes, and writes one remote worker state in one fenced transaction. */
    readonly updateRemoteWorker: (input: {
      readonly owner: string;
      readonly update: RemoteWorkerStateUpdate;
      readonly now: string;
    }) => Effect.Effect<string | undefined, ChannelLedgerError>;
    readonly setWorkerCursor: (input: {
      readonly owner: string;
      readonly cursor: number;
      readonly now: string;
    }) => Effect.Effect<void, ChannelLedgerError>;
    readonly getBot: (
      ownerId: string,
    ) => Effect.Effect<
      { readonly bot: ChannelBotRef; readonly legacyThreadId: ThreadId | undefined } | undefined,
      ChannelLedgerError
    >;
    /** Records the canonical bot unless one exists; returns whichever is stored. */
    readonly setBotIfAbsent: (input: {
      readonly ownerId: string;
      readonly bot: ChannelBotRef;
      readonly legacyThreadId?: ThreadId | undefined;
      readonly now: string;
    }) => Effect.Effect<ChannelBotRef, ChannelLedgerError>;
    /**
     * Replaces the canonical bot if it is still `previousThreadId`, keeping any legacy thread;
     * returns whichever bot is stored afterwards.
     */
    readonly replaceBot: (input: {
      readonly ownerId: string;
      readonly previousThreadId: ThreadId;
      readonly bot: ChannelBotRef;
      readonly now: string;
    }) => Effect.Effect<ChannelBotRef, ChannelLedgerError>;
    readonly findIdentity: (input: {
      readonly connectionId: string;
      readonly externalActorId: string;
    }) => Effect.Effect<ChannelIdentity | undefined, ChannelLedgerError>;
    readonly createIdentityLink: (input: {
      readonly codeHash: string;
      readonly connectionId: string;
      readonly identity: ChannelIdentity;
      readonly expiresAt: string;
      readonly now: string;
    }) => Effect.Effect<void, ChannelLedgerError>;
    /** Consumes a link code once and commits the matching notice. */
    readonly consumeIdentityLink: (input: {
      readonly codeHash: string;
      readonly connectionId: string;
      readonly externalActorId: string;
      readonly now: string;
      readonly notice: ChannelOutboxInsert;
      readonly failureNotice: ChannelOutboxInsert;
    }) => Effect.Effect<
      | { readonly type: "linked"; readonly identity: ChannelIdentity; readonly linkedAt: string }
      | { readonly type: "invalid" },
      ChannelLedgerError
    >;
    readonly unlinkIdentity: (input: {
      readonly connectionId: string;
      readonly externalActorId: string;
    }) => Effect.Effect<boolean, ChannelLedgerError>;
  }
>()("goat/channels/ChannelLedger") {}

const BotState = Schema.Struct({
  bot: ChannelBotRef,
  legacyThreadId: Schema.optional(Schema.String),
});
const ReplyState = Schema.Struct({ text: Schema.String, sentAt: Schema.optional(Schema.String) });
const FailureState = Schema.Struct({ reason: Schema.String, message: Schema.String });

const encodeInbound = Schema.encodeSync(Schema.fromJsonString(ChannelInboundMessage));
const decodeInbound = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelInboundMessage));
const encodeRequester = Schema.encodeSync(Schema.fromJsonString(ChannelRequester));
const decodeRequester = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelRequester));
const encodeDecision = Schema.encodeSync(Schema.fromJsonString(ChannelReceptionResult));
const decodeDecision = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelReceptionResult));
const encodeTask = Schema.encodeSync(Schema.fromJsonString(ChannelTask));
const encodeWorkerRun = Schema.encodeSync(Schema.fromJsonString(ChannelWorkerRun));
const decodeWorkerRun = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelWorkerRun));
const decodeTask = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTask));
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(ChannelTaskEvent));
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTaskEvent));
const encodeExportRow = Schema.encodeSync(Schema.fromJsonString(ChannelTaskLedgerExportRow));
const encodeOutbound = Schema.encodeSync(Schema.fromJsonString(ChannelOutboundMessage));
const decodeOutbound = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelOutboundMessage));
const encodeBot = Schema.encodeSync(Schema.fromJsonString(BotState));
const decodeBot = Schema.decodeUnknownSync(Schema.fromJsonString(BotState));
const encodeScopes = Schema.encodeSync(Schema.fromJsonString(AuthEnvironmentScopes));
const decodeScopes = Schema.decodeUnknownSync(Schema.fromJsonString(AuthEnvironmentScopes));
const encodeStrings = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const ApprovalCodeCount = Schema.fromJsonString(Schema.Struct({ n: Schema.Number }));
const ApprovalCodeOf = Schema.fromJsonString(Schema.Struct({ code: Schema.String }));
const ApprovalCodeTarget = Schema.fromJsonString(Schema.Struct({ requestId: Schema.String }));
const encodeApprovalCount = Schema.encodeSync(ApprovalCodeCount);
const decodeApprovalCount = Schema.decodeUnknownSync(ApprovalCodeCount);
const encodeApprovalOf = Schema.encodeSync(ApprovalCodeOf);
const decodeApprovalOf = Schema.decodeUnknownSync(ApprovalCodeOf);
const encodeApprovalTarget = Schema.encodeSync(ApprovalCodeTarget);
const decodeApprovalTarget = Schema.decodeUnknownSync(ApprovalCodeTarget);
const decodeStrings = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeReply = Schema.encodeSync(Schema.fromJsonString(ReplyState));
const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(ReplyState));
const encodeFailure = Schema.encodeSync(Schema.fromJsonString(FailureState));
const decodeFailure = Schema.decodeUnknownSync(Schema.fromJsonString(FailureState));
const decodeRuntimeMode = Schema.decodeUnknownSync(RuntimeMode);
const CursorState = Schema.Struct({ cursor: Schema.Number });
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(CursorState));
const decodeCursor = Schema.decodeUnknownSync(Schema.fromJsonString(CursorState));
export interface ImessageCursor {
  readonly cursor: number;
  readonly pendingRowIds: ReadonlyArray<number>;
}
const ImessageCursorState = Schema.Struct({
  cursor: Schema.Number,
  pendingRowIds: Schema.Array(Schema.Number),
});
const encodeImessageCursor = Schema.encodeSync(Schema.fromJsonString(ImessageCursorState));
const decodeImessageCursor = Schema.decodeUnknownSync(Schema.fromJsonString(ImessageCursorState));
const validImessageCursor = (state: ImessageCursor) =>
  Number.isSafeInteger(state.cursor) &&
  state.cursor >= 0 &&
  state.pendingRowIds.length <= 128 &&
  state.pendingRowIds.every(
    (id, index, ids) =>
      Number.isSafeInteger(id) &&
      id > 0 &&
      id <= state.cursor &&
      (index === 0 || id > ids[index - 1]!),
  );
const encodeAddress = Schema.encodeSync(Schema.fromJsonString(ChannelReplyAddress));

const WORKER_KEY = "worker";
const CURSOR_KEY = "worker-cursor";
const imessageCursorKey = (connectionId: string) => "imessage-cursor:" + connectionId;
const botKey = (ownerId: string) => "bot:" + ownerId;
/** Remote worker rows never carry an owner token, so the ownership fence cannot match them. */
const remoteWorkerKey = (taskId: ChannelTaskId) => "remote-worker:" + taskId;

/**
 * One change to a remote worker state row. `update` gets the stored JSON (or undefined) and
 * returns the JSON to store; returning the same string leaves the row as it was.
 */
export interface RemoteWorkerStateUpdate {
  readonly taskId: ChannelTaskId;
  readonly update: (current: string | undefined) => string;
}

interface InboxRow {
  readonly input_id: string;
  readonly owner_id: string;
  readonly conversation_id: string;
  readonly binding_id: string;
  readonly content_hash: string;
  readonly message_json: string;
  readonly requester_json: string | null;
  readonly state: string;
  readonly accepted_at: string;
  readonly read_at: string | null;
  readonly reception_id: string | null;
  readonly decision_json: string | null;
  readonly reply_json: string | null;
  readonly failure_json: string | null;
  readonly task_ids_json: string;
  readonly timeline_sequence: number | null;
}

interface TaskRow {
  readonly owner_id: string;
  readonly task_json: string;
  readonly pending_answer_message_id: string | null;
  readonly completion_hold: string | null;
}

interface IdentityRow {
  readonly owner_id: string;
  readonly principal_id: string;
  readonly display_name: string;
  readonly runtime_mode_ceiling: string;
  readonly granted_scopes_json: string;
}

const isChannelLedgerError = Schema.is(ChannelLedgerError);

const toLedgerError =
  (detail: string) =>
  (cause: unknown): ChannelLedgerError =>
    isChannelLedgerError(cause)
      ? cause
      : new ChannelLedgerError({ reason: "persistence", detail, cause });

const INGEST_STATES = new Set(["accepted", "processing", "replied", "rejected"]);

const inboxSnapshot = (row: InboxRow): ChannelStoredInput => {
  const reply = row.reply_json === null ? undefined : decodeReply(row.reply_json);
  const failure = row.failure_json === null ? undefined : decodeFailure(row.failure_json);
  const snapshot = {
    inputId: row.input_id,
    conversationId: row.conversation_id,
    bindingId: row.binding_id,
    duplicate: false,
    // A failed reception still answered the sender, with a failure notice.
    state: INGEST_STATES.has(row.state) ? row.state : "replied",
    acceptedAt: row.accepted_at,
    taskIds: decodeStrings(row.task_ids_json),
    ...(row.reception_id === null ? {} : { receptionId: row.reception_id }),
    ...(row.timeline_sequence === null ? {} : { timelineSequence: row.timeline_sequence }),
    ...(row.read_at === null ? {} : { readAt: row.read_at }),
    ...(reply === undefined
      ? {}
      : {
          reply: {
            text: reply.text,
            inReplyToInputId: row.input_id,
            ...(reply.sentAt === undefined ? {} : { sentAt: reply.sentAt }),
          },
        }),
    ...(failure === undefined ? {} : { failure }),
  } as ChannelInputSnapshot;
  return {
    ownerId: row.owner_id,
    snapshot,
    message: decodeInbound(row.message_json),
    requester: row.requester_json === null ? undefined : decodeRequester(row.requester_json),
    decision: row.decision_json === null ? undefined : decodeDecision(row.decision_json),
  };
};

const storedTask = (row: TaskRow): ChannelStoredTask => ({
  ownerId: row.owner_id,
  task: decodeTask(row.task_json),
  pendingAnswerMessageId: row.pending_answer_message_id ?? undefined,
  completionHold: row.completion_hold ?? undefined,
});

/**
 * When a waiting task last asked for a person: its newest open question or worker need. Marking
 * the bot read covers everything asked before then; a later question counts again.
 */
const channelTaskWaitingSince = (task: ChannelTask): string => {
  const times = [
    ...task.openQuestions.map((question) => question.askedAt),
    ...(task.observed?.needsYou ?? []).map((need) => need.since),
  ];
  if (times.length === 0) return task.updatedAt;
  return times.reduce((latest, time) => (Date.parse(time) > Date.parse(latest) ? time : latest));
};

const toIdentity = (row: IdentityRow): ChannelIdentity => ({
  ownerId: row.owner_id,
  principalId: row.principal_id,
  displayName: row.display_name,
  runtimeModeCeiling: decodeRuntimeMode(row.runtime_mode_ceiling),
  grantedScopes: decodeScopes(row.granted_scopes_json),
});

/** The receipt view of a stored input: no reply or read time. */
const toIngestResult = (stored: ChannelStoredInput, duplicate: boolean): ChannelIngestResult => {
  const { readAt: _readAt, reply: _reply, failure: _failure, ...result } = stored.snapshot;
  return { ...result, duplicate };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const fence = (owner: string | undefined) =>
    owner === undefined
      ? Effect.void
      : sql<{ readonly key: string }>`
          SELECT key FROM channel_runtime_state
          WHERE key = ${WORKER_KEY} AND owner_token = ${owner}
        `.pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.fail(
                  new ChannelLedgerError({
                    reason: "ownership_lost",
                    detail: "Another process owns the channel workers.",
                  }),
                )
              : Effect.void,
          ),
        );

  const insertDeliveries = (deliveries: ReadonlyArray<ChannelOutboxInsert>, now: string) =>
    Effect.forEach(
      deliveries,
      (delivery) => sql`
        INSERT INTO channel_outbox (
          delivery_id, cause_key, input_id, task_id, kind, destination_kind, message_json,
          state, attempts, next_attempt_at, created_at, updated_at
        ) VALUES (
          ${delivery.deliveryId}, ${delivery.causeKey}, ${delivery.inputId ?? null},
          ${delivery.taskId ?? null}, ${delivery.message.kind},
          ${delivery.message.destination.kind}, ${encodeOutbound(delivery.message)},
          'pending', 0, ${now}, ${now}, ${now}
        )
        ON CONFLICT DO NOTHING
      `,
      { discard: true },
    );

  const readInbox = (inputId: string) =>
    sql<InboxRow>`SELECT * FROM channel_inbox WHERE input_id = ${inputId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : inboxSnapshot(rows[0]))),
    );

  const writeTaskEvent = (write: ChannelTaskEventWrite) =>
    Effect.gen(function* () {
      const { next, event } = write;
      const pendingAnswer =
        write.pendingAnswerMessageId === undefined
          ? sql`pending_answer_message_id`
          : sql`${write.pendingAnswerMessageId}`;
      const hold =
        write.completionHold === undefined ? sql`completion_hold` : sql`${write.completionHold}`;
      const updated = yield* sql<{ readonly task_id: string }>`
        UPDATE channel_tasks SET
          status = ${next.status},
          version = ${next.version},
          generation = ${next.generation},
          worker_thread_id = ${next.worker?.threadId ?? null},
          task_json = ${encodeTask(next)},
          updated_at = ${next.updatedAt},
          pending_answer_message_id = ${pendingAnswer},
          completion_hold = ${hold}
        WHERE task_id = ${next.taskId} AND version = ${write.expectedVersion}
        RETURNING task_id
      `;
      if (updated.length === 0) {
        return yield* new ChannelLedgerError({
          reason: "version_conflict",
          detail: "Task " + next.taskId + " is not at version " + write.expectedVersion + ".",
        });
      }
      const inserted = yield* sql<{ readonly sequence: number }>`
        INSERT INTO channel_task_events (
          event_id, task_id, task_version, type, event_json, occurred_at,
          narration_state, forward_state
        ) VALUES (
          ${event.eventId}, ${event.taskId}, ${event.taskVersion}, ${event.type},
          ${encodeEvent(event)}, ${event.occurredAt},
          ${write.narrate === true ? "pending" : "none"},
          ${write.forward === true ? "pending" : "none"}
        )
        RETURNING sequence
      `;
      return inserted[0]?.sequence ?? 0;
    });

  const insertTask = (task: ChannelTask, ownerId: string, event: ChannelTaskEvent) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO channel_tasks (
          task_id, owner_id, conversation_id, status, version, generation, task_json,
          created_at, updated_at
        ) VALUES (
          ${task.taskId}, ${ownerId}, ${task.conversationId}, ${task.status}, ${task.version},
          ${task.generation}, ${encodeTask(task)}, ${task.createdAt}, ${task.updatedAt}
        )
      `;
      yield* sql`
        INSERT INTO channel_task_events (
          event_id, task_id, task_version, type, event_json, occurred_at, narration_state
        ) VALUES (
          ${event.eventId}, ${event.taskId}, ${event.taskVersion}, ${event.type},
          ${encodeEvent(event)}, ${event.occurredAt}, 'none'
        )
      `;
    });

  const workerRunKey = (taskId: string, runId: string) => "worker-run:" + taskId + ":" + runId;

  const upsertCursor = (cursor: number, now: string) => sql`
    INSERT INTO channel_runtime_state (key, value_json, updated_at)
    VALUES (${CURSOR_KEY}, ${encodeCursor({ cursor })}, ${now})
    ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `;

  const patchRemoteWorker = (change: RemoteWorkerStateUpdate, now: string) =>
    Effect.gen(function* () {
      const key = remoteWorkerKey(change.taskId);
      const rows = yield* sql<{ readonly value_json: string }>`
        SELECT value_json FROM channel_runtime_state WHERE key = ${key}
      `;
      const current = rows[0]?.value_json;
      const next = change.update(current);
      if (next !== current) {
        yield* sql`
          INSERT INTO channel_runtime_state (key, value_json, updated_at)
          VALUES (${key}, ${next}, ${now})
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `;
      }
      return next;
    });

  const acceptInput: ChannelLedger["Service"]["acceptInput"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql<InboxRow>`
            SELECT * FROM channel_inbox
            WHERE owner_id = ${input.ownerId} AND kind = ${input.message.kind}
              AND connection_id = ${input.message.connectionId}
              AND idempotency_key = ${input.message.idempotencyKey}
          `;
          const found = existing[0];
          if (found !== undefined) {
            if (found.content_hash !== input.contentHash) {
              return yield* new ChannelLedgerError({
                reason: "idempotency_conflict",
                detail: "Different content under a stored idempotency key.",
              });
            }
            return toIngestResult(inboxSnapshot(found), true);
          }
          yield* sql`
            INSERT INTO channel_conversations (
              conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at
            ) VALUES (
              ${input.conversationId}, ${input.ownerId}, ${input.message.kind},
              ${input.message.connectionId}, ${input.message.conversationKey}, ${input.acceptedAt}
            )
            ON CONFLICT (owner_id, kind, connection_id, conversation_key)
            DO UPDATE SET last_activity_at = excluded.last_activity_at
          `;
          yield* sql`
            INSERT INTO channel_bindings (
              binding_id, conversation_id, connection_id, reply_address_json, last_activity_at
            ) VALUES (
              ${input.bindingId}, ${input.conversationId}, ${input.message.connectionId},
              ${encodeAddress(input.message.replyAddress)}, ${input.acceptedAt}
            )
            ON CONFLICT (binding_id) DO UPDATE SET last_activity_at = excluded.last_activity_at
          `;
          yield* sql`
            INSERT INTO channel_inbox (
              input_id, owner_id, kind, connection_id, idempotency_key, content_hash,
              conversation_id, binding_id, message_json, requester_json, state, accepted_at
            ) VALUES (
              ${input.inputId}, ${input.ownerId}, ${input.message.kind},
              ${input.message.connectionId}, ${input.message.idempotencyKey}, ${input.contentHash},
              ${input.conversationId}, ${input.bindingId}, ${encodeInbound(input.message)},
              ${input.requester === undefined ? null : encodeRequester(input.requester)},
              ${input.requester === undefined ? "rejected" : "accepted"}, ${input.acceptedAt}
            )
          `;
          if (input.rejectNotice !== undefined) {
            yield* insertDeliveries([input.rejectNotice], input.acceptedAt);
          }
          const stored = yield* readInbox(input.inputId);
          if (stored === undefined) {
            return yield* new ChannelLedgerError({
              reason: "persistence",
              detail: "The stored input could not be read back.",
            });
          }
          return toIngestResult(stored, false);
        }),
      )
      .pipe(Effect.mapError(toLedgerError("acceptInput")));

  return ChannelLedger.of({
    acceptInput,

    setTimelineSequence: (inputId, sequence) =>
      sql`UPDATE channel_inbox SET timeline_sequence = ${sequence} WHERE input_id = ${inputId}`.pipe(
        Effect.asVoid,
        Effect.mapError(toLedgerError("setTimelineSequence")),
      ),

    getInput: (inputId) => readInbox(inputId).pipe(Effect.mapError(toLedgerError("getInput"))),

    listPendingInputs: (limit) =>
      sql<{ readonly input_id: ChannelInputId }>`
        SELECT input_id FROM channel_inbox WHERE state IN ('accepted', 'processing')
        ORDER BY accepted_at LIMIT ${limit}
      `.pipe(
        Effect.map((rows) => rows.map((row) => row.input_id)),
        Effect.mapError(toLedgerError("listPendingInputs")),
      ),

    beginReception: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            const rows = yield* sql<{ readonly input_id: string }>`
              UPDATE channel_inbox SET
                state = 'processing',
                reception_id = ${input.receptionId},
                read_at = COALESCE(read_at, ${input.readAt})
              WHERE input_id = ${input.inputId} AND state IN ('accepted', 'processing')
              RETURNING input_id
            `;
            return rows.length === 0 ? undefined : yield* readInbox(input.inputId);
          }),
        )
        .pipe(Effect.mapError(toLedgerError("beginReception"))),

    completeReception: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            const taskIds = [
              ...(input.createdTask === undefined ? [] : [input.createdTask.task.taskId]),
              ...(input.taskEvents ?? []).map((write) => write.next.taskId),
            ];
            const rows = yield* sql<{ readonly owner_id: string }>`
              UPDATE channel_inbox SET
                state = 'replied',
                decision_json = ${encodeDecision(input.decision)},
                reply_json = ${encodeReply({ text: input.replyText })},
                task_ids_json = ${encodeStrings(taskIds)}
              WHERE input_id = ${input.inputId} AND state = 'processing'
                AND reception_id = ${input.receptionId}
              RETURNING owner_id
            `;
            const row = rows[0];
            if (row === undefined) return false;
            if (input.createdTask !== undefined) {
              yield* insertTask(input.createdTask.task, row.owner_id, input.createdTask.event);
            }
            for (const write of input.taskEvents ?? []) yield* writeTaskEvent(write);
            yield* insertDeliveries(input.deliveries, input.now);
            return true;
          }),
        )
        .pipe(Effect.mapError(toLedgerError("completeReception"))),

    failReception: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            const rows = yield* sql<{ readonly input_id: string }>`
              UPDATE channel_inbox SET state = 'failed',
                failure_json = ${encodeFailure(input.failure)}
              WHERE input_id = ${input.inputId} AND state = 'processing'
                AND reception_id = ${input.receptionId}
              RETURNING input_id
            `;
            if (rows.length === 0) return false;
            yield* insertDeliveries(input.deliveries, input.now);
            return true;
          }),
        )
        .pipe(Effect.mapError(toLedgerError("failReception"))),

    readConversationTail: (conversationId, limit) =>
      sql<{
        readonly input_id: ChannelInputId;
        readonly message_json: string;
        readonly accepted_at: string;
        readonly reply_json: string | null;
      }>`
        SELECT input_id, message_json, accepted_at, reply_json FROM channel_inbox
        WHERE conversation_id = ${conversationId} AND state != 'rejected'
        ORDER BY accepted_at DESC, input_id DESC LIMIT ${limit}
      `.pipe(
        Effect.map((rows) =>
          rows
            .map((row) => ({
              inputId: row.input_id,
              text: decodeInbound(row.message_json).text,
              receivedAt: row.accepted_at,
              replyText: row.reply_json === null ? undefined : decodeReply(row.reply_json).text,
            }))
            .toReversed(),
        ),
        Effect.mapError(toLedgerError("readConversationTail")),
      ),

    searchConversation: (conversationId, query, limit, beforeInputId) => {
      const pattern = "%" + query.replace(/[\\%_]/gu, (char) => "\\" + char) + "%";
      return sql<{
        readonly input_id: ChannelInputId;
        readonly message_json: string;
        readonly accepted_at: string;
        readonly reply_json: string | null;
      }>`
        SELECT input_id, message_json, accepted_at, reply_json FROM channel_inbox
        WHERE conversation_id = ${conversationId} AND state != 'rejected'
          -- Rows are stored in the order inputs were accepted, so rowid orders them without ties.
          AND EXISTS (
            SELECT 1 FROM channel_inbox AS asking WHERE asking.input_id = ${beforeInputId}
              AND channel_inbox.rowid < asking.rowid
          )
          AND (json_extract(message_json, '$.text') LIKE ${pattern} ESCAPE '\\'
            OR json_extract(reply_json, '$.text') LIKE ${pattern} ESCAPE '\\')
        ORDER BY accepted_at DESC, input_id DESC LIMIT ${limit}
      `.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            inputId: row.input_id,
            text: decodeInbound(row.message_json).text,
            receivedAt: row.accepted_at,
            replyText: row.reply_json === null ? undefined : decodeReply(row.reply_json).text,
          })),
        ),
        Effect.mapError(toLedgerError("searchConversation")),
      );
    },

    listConversationTasks: (conversationId) =>
      sql<TaskRow>`
        SELECT owner_id, task_json, pending_answer_message_id, completion_hold FROM channel_tasks
        WHERE conversation_id = ${conversationId} ORDER BY created_at DESC LIMIT 20
      `.pipe(
        Effect.map((rows) => rows.map((row) => storedTask(row).task)),
        Effect.mapError(toLedgerError("listConversationTasks")),
      ),

    listConversationNeedsYou: (conversationId) =>
      sql<TaskRow>`
        SELECT owner_id, task_json, pending_answer_message_id, completion_hold FROM channel_tasks
        WHERE conversation_id = ${conversationId}
          AND status IN ('running', 'waiting_input')
          AND COALESCE(json_array_length(task_json, '$.observed.needsYou'), 0) > 0
        ORDER BY created_at DESC
      `.pipe(
        Effect.map((rows) => rows.map((row) => storedTask(row).task)),
        Effect.mapError(toLedgerError("listConversationNeedsYou")),
      ),

    getTask: (taskId) =>
      sql<TaskRow>`
        SELECT owner_id, task_json, pending_answer_message_id, completion_hold FROM channel_tasks
        WHERE task_id = ${taskId}
      `.pipe(
        Effect.map((rows) => (rows[0] === undefined ? undefined : storedTask(rows[0]))),
        Effect.mapError(toLedgerError("getTask")),
      ),

    listTasks: (input) =>
      Effect.gen(function* () {
        const separator = input.cursor?.indexOf("|") ?? -1;
        const cursorAt = separator < 0 ? undefined : input.cursor?.slice(0, separator);
        const cursorId = separator < 0 ? undefined : input.cursor?.slice(separator + 1);
        const statusFilter =
          input.statuses === undefined || input.statuses.length === 0
            ? sql``
            : sql`AND status IN ${sql.in(input.statuses)}`;
        const cursorFilter =
          cursorAt === undefined || cursorId === undefined
            ? sql``
            : sql`AND (updated_at < ${cursorAt} OR (updated_at = ${cursorAt} AND task_id < ${cursorId}))`;
        const rows = yield* sql<
          TaskRow & { readonly task_id: string; readonly updated_at: string }
        >`
          SELECT task_id, updated_at, owner_id, task_json, pending_answer_message_id,
            completion_hold
          FROM channel_tasks
          WHERE owner_id = ${input.ownerId} ${statusFilter} ${cursorFilter}
          ORDER BY updated_at DESC, task_id DESC
          LIMIT ${input.limit + 1}
        `;
        const page = rows.slice(0, input.limit);
        const last = page.at(-1);
        return {
          tasks: page.map((row) => storedTask(row).task),
          nextCursor:
            rows.length > input.limit && last !== undefined
              ? last.updated_at + "|" + last.task_id
              : undefined,
        };
      }).pipe(Effect.mapError(toLedgerError("listTasks"))),

    latestTaskBrief: (taskId) =>
      sql<{ readonly event_json: string }>`
        SELECT event_json FROM channel_task_events
        WHERE task_id = ${taskId} AND type = 'task.brief.frozen'
        ORDER BY sequence DESC LIMIT 1
      `.pipe(
        Effect.map((rows) => {
          const event = rows[0] === undefined ? undefined : decodeEvent(rows[0].event_json);
          return event?.type === "task.brief.frozen" ? event.payload.brief : undefined;
        }),
        Effect.mapError(toLedgerError("latestTaskBrief")),
      ),

    exportTasks: (input) =>
      Effect.gen(function* () {
        const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
        const after = input.cursor === undefined ? 0 : Number(input.cursor);
        if (!Number.isSafeInteger(after) || after < 0) {
          return yield* new ChannelLedgerError({
            reason: "persistence",
            detail: "Invalid export cursor.",
          });
        }
        const rows = yield* sql<{
          readonly sequence: number;
          readonly owner_id: string;
          readonly task_json: string;
          readonly event_json: string;
          readonly brief_json: string | null;
          readonly worker_json: string | null;
          readonly human_interventions: number;
          readonly reruns: number;
        }>`
          SELECT outcome.sequence, task.owner_id, task.task_json, outcome.event_json,
            (SELECT frozen.event_json FROM channel_task_events AS frozen
              WHERE frozen.task_id = outcome.task_id AND frozen.type = 'task.brief.frozen'
                AND frozen.sequence < outcome.sequence
                AND json_extract(frozen.event_json, '$.payload.brief.version') =
                  json_extract(outcome.event_json, '$.payload.briefVersion')
              ORDER BY frozen.sequence DESC LIMIT 1) AS brief_json,
            (SELECT bound.event_json FROM channel_task_events AS bound
              WHERE bound.task_id = outcome.task_id AND bound.type = 'task.worker.bound'
                AND bound.sequence < outcome.sequence
              ORDER BY bound.sequence DESC LIMIT 1) AS worker_json,
            (SELECT COUNT(*) FROM channel_task_events AS answer
              WHERE answer.task_id = outcome.task_id AND answer.type = 'task.question.answered'
                AND answer.sequence < outcome.sequence
                AND answer.sequence > COALESCE((
                  SELECT MAX(boundary.sequence) FROM channel_task_events AS boundary
                  WHERE boundary.task_id = outcome.task_id AND boundary.type = 'task.retry.requested'
                    AND boundary.sequence < outcome.sequence
                ), 0)) AS human_interventions,
            (SELECT COUNT(*) FROM channel_task_events AS retry
              WHERE retry.task_id = outcome.task_id AND retry.type = 'task.retry.requested'
                AND retry.sequence < outcome.sequence) AS reruns
          FROM channel_task_events AS outcome
          JOIN channel_tasks AS task ON task.task_id = outcome.task_id
          WHERE task.owner_id = ${input.ownerId}
            AND outcome.type IN ('task.completed', 'task.failed', 'task.cancelled')
            AND julianday(outcome.occurred_at) >= julianday(${input.from})
            AND julianday(outcome.occurred_at) < julianday(${input.to})
            AND outcome.sequence > ${after}
          ORDER BY outcome.sequence LIMIT ${limit + 1}
        `;
        const page = rows.slice(0, limit);
        const lines = page.map((row) => {
          const task = decodeTask(row.task_json);
          const outcome = decodeEvent(row.event_json);
          const frozen = row.brief_json === null ? undefined : decodeEvent(row.brief_json);
          const bound = row.worker_json === null ? undefined : decodeEvent(row.worker_json);
          const brief = frozen?.type === "task.brief.frozen" ? frozen.payload.brief : null;
          const generation =
            outcome.type === "task.completed" || outcome.type === "task.failed"
              ? outcome.payload.generation
              : row.reruns + 1;
          const worker =
            bound?.type === "task.worker.bound" && bound.payload.worker.generation === generation
              ? bound.payload.worker
              : undefined;
          return encodeExportRow({
            sequence: row.sequence,
            taskId: task.taskId,
            ownerId: row.owner_id,
            requester: task.requester,
            conversationId: task.conversationId,
            originBindingId: task.originBindingId,
            originAddress: task.originAddress,
            originInputId: task.originInputId,
            title: task.title,
            brief,
            terminalState:
              outcome.type === "task.completed"
                ? "completed"
                : outcome.type === "task.failed"
                  ? "failed"
                  : "cancelled",
            occurredAt: outcome.occurredAt,
            resultSummary:
              outcome.type === "task.completed"
                ? outcome.payload.summary
                : outcome.type === "task.failed"
                  ? (outcome.payload.summary ?? outcome.payload.reason)
                  : outcome.type === "task.cancelled"
                    ? (outcome.payload.reason ?? null)
                    : null,
            // The ledger stores worker/run pointers and summaries, not transcript evidence.
            evidence: worker ?? null,
            channelAnswers: row.human_interventions,
            reruns: row.reruns,
            generation,
          });
        });
        const last = page.at(-1);
        return {
          jsonl: lines.length === 0 ? "" : lines.join("\n") + "\n",
          ...(rows.length > limit && last !== undefined
            ? { nextCursor: String(last.sequence) }
            : {}),
        };
      }).pipe(Effect.mapError(toLedgerError("exportTasks"))),

    answerEventIdsThrough: (taskId, sequence) =>
      sql<{ readonly event_id: ChannelTaskEventId }>`
        SELECT event_id FROM channel_task_events
        WHERE task_id = ${taskId} AND type = 'task.question.answered' AND sequence < ${sequence}
          AND sequence > COALESCE((
            SELECT MAX(boundary.sequence) FROM channel_task_events AS boundary
            WHERE boundary.task_id = ${taskId} AND boundary.type = 'task.retry.requested'
              AND boundary.sequence < ${sequence}
          ), 0)
        ORDER BY sequence LIMIT 501
      `.pipe(
        Effect.map((rows) => ({
          eventIds: rows.slice(0, 500).map((row) => row.event_id),
          overflow: rows.length > 500,
        })),
        Effect.mapError(toLedgerError("answerEventIdsThrough")),
      ),

    listTasksByStatus: (statuses) =>
      sql<TaskRow>`
        SELECT owner_id, task_json, pending_answer_message_id, completion_hold FROM channel_tasks
        WHERE status IN ${sql.in(statuses)} ORDER BY updated_at
      `.pipe(
        Effect.map((rows) => rows.map(storedTask)),
        Effect.mapError(toLedgerError("listTasksByStatus")),
      ),

    countWaitingTasks: (ownerId, readThrough) =>
      sql<TaskRow>`
        SELECT owner_id, task_json, pending_answer_message_id, completion_hold FROM channel_tasks
        WHERE owner_id = ${ownerId}
          AND (
            status = 'waiting_input'
            OR (
              status = 'running'
              AND COALESCE(json_array_length(task_json, '$.observed.needsYou'), 0) > 0
            )
          )
      `.pipe(
        Effect.map((rows) => {
          if (readThrough === undefined) return rows.length;
          const readMs = Date.parse(readThrough);
          return rows.filter(
            (row) => Date.parse(channelTaskWaitingSince(decodeTask(row.task_json))) > readMs,
          ).length;
        }),
        Effect.mapError(toLedgerError("countWaitingTasks")),
      ),

    findTaskByWorkerThread: (threadId) =>
      sql<TaskRow>`
        SELECT owner_id, task_json, pending_answer_message_id, completion_hold FROM channel_tasks
        WHERE worker_thread_id = ${threadId} ORDER BY updated_at DESC LIMIT 1
      `.pipe(
        Effect.map((rows) => (rows[0] === undefined ? undefined : storedTask(rows[0]))),
        Effect.mapError(toLedgerError("findTaskByWorkerThread")),
      ),

    applyTaskEvent: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            const sequence = yield* writeTaskEvent(input.write);
            yield* insertDeliveries(input.deliveries, input.write.event.occurredAt);
            if (input.cursor !== undefined) {
              yield* upsertCursor(input.cursor, input.write.event.occurredAt);
            }
            if (input.remoteWorker !== undefined) {
              yield* patchRemoteWorker(input.remoteWorker, input.write.event.occurredAt);
            }
            return sequence;
          }),
        )
        .pipe(Effect.mapError(toLedgerError("applyTaskEvent"))),

    setCompletionHold: (input) =>
      sql
        .withTransaction(
          fence(input.owner).pipe(
            Effect.andThen(
              sql`UPDATE channel_tasks SET completion_hold = ${input.hold} WHERE task_id = ${input.taskId}`,
            ),
          ),
        )
        .pipe(Effect.asVoid, Effect.mapError(toLedgerError("setCompletionHold"))),

    hasTaskEvent: (eventId) =>
      sql<{ readonly event_id: string }>`
        SELECT event_id FROM channel_task_events WHERE event_id = ${eventId}
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(toLedgerError("hasTaskEvent")),
      ),

    listPendingNarrations: (limit) =>
      sql<{ readonly sequence: number; readonly event_json: string }>`
        SELECT sequence, event_json FROM channel_task_events
        WHERE narration_state = 'pending' ORDER BY sequence LIMIT ${limit}
      `.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({ sequence: row.sequence, event: decodeEvent(row.event_json) })),
        ),
        Effect.mapError(toLedgerError("listPendingNarrations")),
      ),

    completeNarration: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            const rows = yield* sql<{ readonly sequence: number }>`
              UPDATE channel_task_events SET narration_state = 'done'
              WHERE sequence = ${input.sequence} AND narration_state = 'pending'
              RETURNING sequence
            `;
            if (rows.length > 0) yield* insertDeliveries(input.deliveries, input.now);
          }),
        )
        .pipe(Effect.mapError(toLedgerError("completeNarration"))),

    listPendingForwards: (limit) =>
      sql<{ readonly sequence: number; readonly event_json: string }>`
        SELECT sequence, event_json FROM channel_task_events
        WHERE forward_state = 'pending' ORDER BY sequence LIMIT ${limit}
      `.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({ sequence: row.sequence, event: decodeEvent(row.event_json) })),
        ),
        Effect.mapError(toLedgerError("listPendingForwards")),
      ),

    upsertWorkerRun: (run, deliveries = []) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO channel_runtime_state (key, value_json, updated_at)
              VALUES (${workerRunKey(run.taskId, run.runId)}, ${encodeWorkerRun(run)}, ${run.updatedAt})
              ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
                updated_at = excluded.updated_at
            `;
            if (deliveries.length > 0) yield* insertDeliveries(deliveries, run.updatedAt);
          }),
        )
        .pipe(Effect.asVoid, Effect.mapError(toLedgerError("upsertWorkerRun"))),

    listWorkerRuns: (taskIds) =>
      taskIds.length === 0
        ? Effect.succeed([])
        : Effect.forEach(
            taskIds,
            (taskId) =>
              sql<{ readonly value_json: string }>`
              SELECT value_json FROM channel_runtime_state
              WHERE key >= ${"worker-run:" + taskId + ":"} AND key < ${"worker-run:" + taskId + ";"}
            `,
          ).pipe(
            Effect.map((pages) =>
              pages
                .flat()
                .map((row) => decodeWorkerRun(row.value_json))
                .toSorted((left, right) =>
                  left.taskId === right.taskId
                    ? left.startedAt.localeCompare(right.startedAt)
                    : left.taskId.localeCompare(right.taskId),
                ),
            ),
            Effect.mapError(toLedgerError("listWorkerRuns")),
          ),

    listUndeliveredOutcomes: (ownerId) =>
      sql<TaskRow>`
        SELECT task.owner_id, task.task_json, task.pending_answer_message_id, task.completion_hold
        FROM channel_tasks AS task
        JOIN channel_task_events AS outcome ON outcome.task_id = task.task_id
        LEFT JOIN channel_outbox AS delivery
          ON delivery.cause_key = 'narration:' || outcome.event_id || ':origin'
        WHERE task.owner_id = ${ownerId}
          AND task.status IN ('completed', 'failed', 'cancelled')
          AND outcome.sequence = (
            SELECT MAX(latest.sequence) FROM channel_task_events AS latest
            WHERE latest.task_id = task.task_id
              AND latest.type IN ('task.completed', 'task.failed', 'task.cancelled')
          )
          AND (delivery.state IS NULL OR delivery.state != 'delivered')
      `.pipe(
        Effect.map((rows) => rows.map((row) => storedTask(row).task)),
        Effect.mapError(toLedgerError("listUndeliveredOutcomes")),
      ),

    listUnsettledRunHistory: (input) =>
      sql<TaskRow>`
        SELECT owner_id, task_json, pending_answer_message_id, completion_hold FROM channel_tasks
        WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at >= ${input.since}
          AND json_extract(task_json, '$.target') IS NOT NULL
          AND json_extract(task_json, '$.target.remote') IS NULL
          AND json_extract(task_json, '$.worker.host') IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM channel_runtime_state WHERE key = 'runs-final:' || channel_tasks.task_id
          )
        ORDER BY updated_at DESC LIMIT ${input.limit}
      `.pipe(
        Effect.map((rows) => rows.map((row) => storedTask(row).task)),
        Effect.mapError(toLedgerError("listUnsettledRunHistory")),
      ),

    settleRunHistory: (input) =>
      sql`
        INSERT INTO channel_runtime_state (key, value_json, updated_at)
        VALUES (${"runs-final:" + input.taskId}, '{}', ${input.now})
        ON CONFLICT (key) DO NOTHING
      `.pipe(Effect.asVoid, Effect.mapError(toLedgerError("settleRunHistory"))),

    issueApprovalCode: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const ofKey = "approval-code-of:" + input.requestId;
            const issued = yield* sql<{ readonly value_json: string }>`
              SELECT value_json FROM channel_runtime_state WHERE key = ${ofKey}
            `;
            if (issued[0] !== undefined) {
              return decodeApprovalOf(issued[0].value_json).code;
            }
            const counterKey = "approval-codes:" + input.conversationId;
            const counter = yield* sql<{ readonly value_json: string }>`
              SELECT value_json FROM channel_runtime_state WHERE key = ${counterKey}
            `;
            const next =
              (counter[0] === undefined ? 0 : decodeApprovalCount(counter[0].value_json).n) + 1;
            const code = "A" + next;
            yield* sql`
              INSERT INTO channel_runtime_state (key, value_json, updated_at)
              VALUES (${counterKey}, ${encodeApprovalCount({ n: next })}, ${input.now})
              ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
                updated_at = excluded.updated_at
            `;
            yield* sql`
              INSERT INTO channel_runtime_state (key, value_json, updated_at)
              VALUES (
                ${"approval-code:" + code + ":" + input.conversationId},
                ${encodeApprovalTarget({ requestId: input.requestId })},
                ${input.now}
              )
            `;
            yield* sql`
              INSERT INTO channel_runtime_state (key, value_json, updated_at)
              VALUES (
                ${ofKey},
                ${encodeApprovalOf({ code })},
                ${input.now}
              )
            `;
            return code;
          }),
        )
        .pipe(Effect.mapError(toLedgerError("issueApprovalCode"))),

    approvalCodeForRequest: (requestId) =>
      sql<{ readonly value_json: string; readonly updated_at: string }>`
        SELECT value_json, updated_at FROM channel_runtime_state
        WHERE key = ${"approval-code-of:" + requestId}
      `.pipe(
        Effect.map((rows) => {
          const row = rows[0];
          if (row === undefined) return undefined;
          return { code: decodeApprovalOf(row.value_json).code, issuedAt: row.updated_at };
        }),
        Effect.mapError(toLedgerError("approvalCodeForRequest")),
      ),

    approvalRequestForCode: (input) =>
      sql<{ readonly value_json: string }>`
        SELECT value_json FROM channel_runtime_state
        WHERE key = ${"approval-code:" + input.code + ":" + input.conversationId}
      `.pipe(
        Effect.map((rows) =>
          rows[0] === undefined ? undefined : decodeApprovalTarget(rows[0].value_json).requestId,
        ),
        Effect.mapError(toLedgerError("approvalRequestForCode")),
      ),

    stopAttempt: (eventId) =>
      sql<{ readonly value_json: string }>`
        SELECT value_json FROM channel_runtime_state WHERE key = ${"stop-attempt:" + eventId}
      `.pipe(
        Effect.map((rows) =>
          rows[0] === undefined
            ? 0
            : (JSON.parse(rows[0].value_json) as { attempt: number }).attempt,
        ),
        Effect.mapError(toLedgerError("stopAttempt")),
      ),

    advanceStopAttempt: (input) =>
      sql`
        INSERT INTO channel_runtime_state (key, value_json, updated_at)
        VALUES (${"stop-attempt:" + input.eventId}, ${JSON.stringify({ attempt: input.from + 1 })}, ${input.now})
        ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
          updated_at = excluded.updated_at
        WHERE json_extract(channel_runtime_state.value_json, '$.attempt') = ${input.from}
      `.pipe(Effect.asVoid, Effect.mapError(toLedgerError("advanceStopAttempt"))),

    listOpenWorkerRuns: () =>
      sql<{ readonly value_json: string }>`
        SELECT value_json FROM channel_runtime_state
        WHERE key >= 'worker-run:' AND key < 'worker-run;'
          AND json_extract(value_json, '$.status') IN ('running', 'waiting', 'stalled')
      `.pipe(
        Effect.map((rows) => rows.map((row) => decodeWorkerRun(row.value_json))),
        Effect.mapError(toLedgerError("listOpenWorkerRuns")),
      ),

    countBusyTasks: (input) =>
      sql<{ readonly busy: number }>`
        SELECT COUNT(*) AS busy FROM channel_tasks
        WHERE owner_id = ${input.ownerId}
          AND json_extract(task_json, '$.requester.principalId') = ${input.principalId}
          AND (status IN ('dispatching', 'running')
            OR (status = 'waiting_input' AND json_extract(task_json, '$.worker') IS NOT NULL)
            -- Stopped, but its worker may still run until the stop goes through.
            OR (status = 'cancelled' AND EXISTS (
              SELECT 1 FROM channel_task_events AS stop
              WHERE stop.task_id = channel_tasks.task_id AND stop.type = 'task.cancelled'
                AND stop.forward_state = 'pending'
            )))
      `.pipe(
        Effect.map((rows) => rows[0]?.busy ?? 0),
        Effect.mapError(toLedgerError("countBusyTasks")),
      ),

    outcomeDeliveries: (taskIds) =>
      taskIds.length === 0
        ? Effect.succeed(new Map())
        : sql<{ readonly task_id: string; readonly state: string | null }>`
            SELECT outcome.task_id, delivery.state FROM channel_task_events AS outcome
            LEFT JOIN channel_outbox AS delivery
              ON delivery.cause_key = 'narration:' || outcome.event_id || ':origin'
            WHERE outcome.task_id IN ${sql.in(taskIds)}
              AND outcome.type IN ('task.completed', 'task.failed', 'task.cancelled')
              AND outcome.sequence = (
                SELECT MAX(latest.sequence) FROM channel_task_events AS latest
                WHERE latest.task_id = outcome.task_id
                  AND latest.type IN ('task.completed', 'task.failed', 'task.cancelled')
              )
          `.pipe(
            Effect.map(
              (rows) =>
                new Map(
                  rows.flatMap((row) => (row.state === null ? [] : [[row.task_id, row.state]])),
                ),
            ),
            Effect.mapError(toLedgerError("outcomeDeliveries")),
          ),

    hasPendingForward: (taskId) =>
      sql<{ readonly found: number }>`
        SELECT 1 AS found FROM channel_task_events
        WHERE task_id = ${taskId} AND forward_state = 'pending' LIMIT 1
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(toLedgerError("hasPendingForward")),
      ),

    hasEarlierPendingForward: (input) =>
      sql<{ readonly found: number }>`
        SELECT 1 AS found FROM channel_task_events
        WHERE task_id = ${input.taskId} AND forward_state = 'pending'
          AND sequence < ${input.sequence}
        LIMIT 1
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(toLedgerError("hasEarlierPendingForward")),
      ),

    completeForward: (input) =>
      sql
        .withTransaction(
          fence(input.owner).pipe(
            Effect.andThen(
              sql`UPDATE channel_task_events SET forward_state = 'done' WHERE sequence = ${input.sequence}`,
            ),
          ),
        )
        .pipe(Effect.asVoid, Effect.mapError(toLedgerError("completeForward"))),

    enqueueDeliveries: (deliveries, now) =>
      insertDeliveries(deliveries, now).pipe(Effect.mapError(toLedgerError("enqueueDeliveries"))),

    claimDueDeliveries: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            const rows = yield* sql<{
              readonly row_order: number;
              readonly delivery_id: ChannelDeliveryId;
              readonly message_json: string;
              readonly attempts: number;
            }>`
              UPDATE channel_outbox SET state = 'delivering', attempts = attempts + 1,
                updated_at = ${input.now}
              WHERE delivery_id IN (
                SELECT due.delivery_id FROM channel_outbox AS due
                -- The IN term lets SQLite use the partial due index; = 'pending' is the real filter.
                WHERE due.state IN ('pending', 'delivering') AND due.state = 'pending'
                  AND due.next_attempt_at <= ${input.now}
                  AND NOT EXISTS (
                    SELECT 1 FROM channel_outbox AS earlier
                    WHERE earlier.task_id = due.task_id
                      AND earlier.destination_kind = due.destination_kind
                      AND earlier.state IN ('pending', 'delivering')
                      AND earlier.rowid < due.rowid
                  )
                ORDER BY due.created_at, due.rowid LIMIT ${input.limit}
              )
              RETURNING rowid AS row_order, delivery_id, message_json, attempts
            `;
            return rows
              .toSorted((left, right) => left.row_order - right.row_order)
              .map((row) => ({
                deliveryId: row.delivery_id,
                message: decodeOutbound(row.message_json),
                attempts: row.attempts,
              }));
          }),
        )
        .pipe(Effect.mapError(toLedgerError("claimDueDeliveries"))),

    recordDelivery: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            const outcome = input.outcome;
            switch (outcome.type) {
              case "delivered":
                yield* sql`
                  UPDATE channel_outbox SET state = 'delivered',
                    external_message_id = ${outcome.externalMessageId ?? null},
                    updated_at = ${input.now}
                  WHERE delivery_id = ${input.deliveryId}
                `;
                return;
              case "retry":
                yield* sql`
                  UPDATE channel_outbox SET state = 'pending', next_attempt_at = ${outcome.at},
                    last_error_code = ${outcome.errorCode}, updated_at = ${input.now}
                  WHERE delivery_id = ${input.deliveryId}
                `;
                return;
              case "ambiguous":
              case "failed":
                yield* sql`
                  UPDATE channel_outbox SET state = ${outcome.type},
                    last_error_code = ${outcome.errorCode}, updated_at = ${input.now}
                  WHERE delivery_id = ${input.deliveryId}
                `;
                return;
            }
          }),
        )
        .pipe(Effect.mapError(toLedgerError("recordDelivery"))),

    settleInterruptedDeliveries: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            // Local destinations record idempotently, so an interrupted one is simply sent again.
            yield* sql`
              UPDATE channel_outbox SET state = 'pending', updated_at = ${input.now}
              WHERE state = 'delivering' AND destination_kind IN ('goat', 'mcp')
            `;
            yield* sql`
              UPDATE channel_outbox SET state = 'ambiguous', last_error_code = 'interrupted',
                updated_at = ${input.now}
              WHERE state = 'delivering' AND destination_kind NOT IN ('goat', 'mcp')
            `;
          }),
        )
        .pipe(Effect.mapError(toLedgerError("settleInterruptedDeliveries"))),

    getDeliveryState: (deliveryId) =>
      sql<{ readonly state: string }>`
        SELECT state FROM channel_outbox WHERE delivery_id = ${deliveryId}
      `.pipe(
        Effect.map((rows) => rows[0]?.state),
        Effect.mapError(toLedgerError("getDeliveryState")),
      ),

    claimOwnership: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO channel_runtime_state (key, value_json, owner_token, heartbeat_at, updated_at)
              VALUES (${WORKER_KEY}, '{}', ${input.token}, ${input.now}, ${input.now})
              ON CONFLICT (key) DO NOTHING
            `;
            const rows = yield* sql<{ readonly key: string }>`
              UPDATE channel_runtime_state SET owner_token = ${input.token},
                heartbeat_at = ${input.now}, updated_at = ${input.now}
              WHERE key = ${WORKER_KEY}
                AND (owner_token = ${input.token} OR heartbeat_at IS NULL
                  OR heartbeat_at < ${input.staleBefore})
              RETURNING key
            `;
            return rows.length > 0;
          }),
        )
        .pipe(Effect.mapError(toLedgerError("claimOwnership"))),

    getWorkerCursor: () =>
      sql<{ readonly value_json: string }>`
        SELECT value_json FROM channel_runtime_state WHERE key = ${CURSOR_KEY}
      `.pipe(
        Effect.map((rows) =>
          rows[0] === undefined ? undefined : decodeCursor(rows[0].value_json).cursor,
        ),
        Effect.mapError(toLedgerError("getWorkerCursor")),
      ),

    getImessageCursor: (connectionId) =>
      sql<{ readonly value_json: string }>`
        SELECT value_json FROM channel_runtime_state WHERE key = ${imessageCursorKey(connectionId)}
      `.pipe(
        Effect.flatMap((rows) => {
          if (rows[0] === undefined) return Effect.succeed(undefined);
          const state = decodeImessageCursor(rows[0].value_json);
          return validImessageCursor(state)
            ? Effect.succeed(state)
            : Effect.fail(
                new ChannelLedgerError({
                  reason: "persistence",
                  detail: "Invalid iMessage cursor state.",
                }),
              );
        }),
        Effect.mapError(toLedgerError("getImessageCursor")),
      ),

    checkpointImessageCursor: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            const valid =
              validImessageCursor(input.next) &&
              (input.expected === undefined || input.next.cursor >= input.expected.cursor) &&
              (input.expected === undefined || validImessageCursor(input.expected));
            if (!valid)
              return yield* new ChannelLedgerError({
                reason: "version_conflict",
                detail: "Invalid iMessage cursor.",
              });
            const key = imessageCursorKey(input.connectionId);
            const rows = yield* sql<{ readonly value_json: string }>`
          SELECT value_json FROM channel_runtime_state WHERE key = ${key}
        `;
            const old =
              rows[0] === undefined ? undefined : decodeImessageCursor(rows[0].value_json);
            if (
              (old === undefined ? undefined : encodeImessageCursor(old)) !==
              (input.expected === undefined ? undefined : encodeImessageCursor(input.expected))
            )
              return yield* new ChannelLedgerError({
                reason: "version_conflict",
                detail: "iMessage cursor changed.",
              });
            yield* sql`
          INSERT INTO channel_runtime_state (key, value_json, updated_at)
          VALUES (${key}, ${encodeImessageCursor(input.next)}, ${input.now})
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `;
          }),
        )
        .pipe(Effect.mapError(toLedgerError("checkpointImessageCursor"))),

    isOwner: (owner) =>
      sql<{ readonly key: string }>`
        SELECT key FROM channel_runtime_state WHERE key = ${WORKER_KEY} AND owner_token = ${owner}
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(toLedgerError("isOwner")),
      ),

    getRemoteWorker: (taskId) =>
      sql<{ readonly value_json: string }>`
        SELECT value_json FROM channel_runtime_state WHERE key = ${remoteWorkerKey(taskId)}
      `.pipe(
        Effect.map((rows) => rows[0]?.value_json),
        Effect.mapError(toLedgerError("getRemoteWorker")),
      ),

    recentAnswers: (taskId, limit) =>
      sql<{ readonly event_json: string }>`
        SELECT event_json FROM channel_task_events
        WHERE task_id = ${taskId} AND type = 'task.question.answered'
          AND sequence > COALESCE((
            SELECT MAX(sequence) FROM channel_task_events
            WHERE task_id = ${taskId} AND type = 'task.retry.requested'
          ), 0)
        ORDER BY sequence DESC LIMIT ${limit}
      `.pipe(
        Effect.map((rows) =>
          rows.flatMap((row) => {
            const event = decodeEvent(row.event_json);
            return event.type === "task.question.answered" ? [event] : [];
          }),
        ),
        Effect.mapError(toLedgerError("recentAnswers")),
      ),

    rememberedProjectChoice: (taskId) =>
      sql<{ readonly event_json: string }>`
        SELECT event_json FROM channel_task_events
        WHERE task_id = ${taskId} AND type = 'task.question.answered'
          AND sequence > COALESCE((
            SELECT MAX(sequence) FROM channel_task_events
            WHERE task_id = ${taskId} AND type = 'task.retry.requested'
          ), 0)
          AND COALESCE(json_extract(event_json, '$.payload.projectChoice.type'), '') != 'none'
        ORDER BY sequence DESC LIMIT 1
      `.pipe(
        Effect.map((rows) => {
          const event = rows[0] === undefined ? undefined : decodeEvent(rows[0].event_json);
          return event?.type === "task.question.answered" ? event.payload.projectChoice : undefined;
        }),
        Effect.mapError(toLedgerError("rememberedProjectChoice")),
      ),

    recordAnswerProjectChoice: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            const rows = yield* sql<{ readonly event_json: string }>`
              SELECT event_json FROM channel_task_events WHERE event_id = ${input.eventId}
            `;
            const event = rows[0] === undefined ? undefined : decodeEvent(rows[0].event_json);
            if (
              event?.type !== "task.question.answered" ||
              event.payload.projectChoice !== undefined
            )
              return;
            const updated = encodeEvent({
              ...event,
              payload: { ...event.payload, projectChoice: input.choice },
            });
            yield* sql`UPDATE channel_task_events SET event_json = ${updated} WHERE event_id = ${input.eventId}`;
          }),
        )
        .pipe(Effect.asVoid, Effect.mapError(toLedgerError("recordAnswerProjectChoice"))),

    updateRemoteWorker: (input) =>
      sql
        .withTransaction(
          fence(input.owner).pipe(Effect.andThen(patchRemoteWorker(input.update, input.now))),
        )
        .pipe(Effect.mapError(toLedgerError("updateRemoteWorker"))),

    setWorkerCursor: (input) =>
      sql
        .withTransaction(
          fence(input.owner).pipe(Effect.andThen(upsertCursor(input.cursor, input.now))),
        )
        .pipe(Effect.asVoid, Effect.mapError(toLedgerError("setWorkerCursor"))),

    getBot: (ownerId) =>
      sql<{ readonly value_json: string }>`
        SELECT value_json FROM channel_runtime_state WHERE key = ${botKey(ownerId)}
      `.pipe(
        Effect.map((rows) => {
          if (rows[0] === undefined) return undefined;
          const stored = decodeBot(rows[0].value_json);
          return {
            bot: stored.bot,
            legacyThreadId: stored.legacyThreadId as ThreadId | undefined,
          };
        }),
        Effect.mapError(toLedgerError("getBot")),
      ),

    setBotIfAbsent: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const value = encodeBot({
              bot: input.bot,
              ...(input.legacyThreadId === undefined
                ? {}
                : { legacyThreadId: input.legacyThreadId }),
            });
            yield* sql`
              INSERT INTO channel_runtime_state (key, value_json, updated_at)
              VALUES (${botKey(input.ownerId)}, ${value}, ${input.now})
              ON CONFLICT (key) DO NOTHING
            `;
            const rows = yield* sql<{ readonly value_json: string }>`
              SELECT value_json FROM channel_runtime_state WHERE key = ${botKey(input.ownerId)}
            `;
            const stored = rows[0];
            return stored === undefined ? input.bot : decodeBot(stored.value_json).bot;
          }),
        )
        .pipe(Effect.mapError(toLedgerError("setBotIfAbsent"))),

    replaceBot: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const key = botKey(input.ownerId);
            const rows = yield* sql<{ readonly value_json: string }>`
              SELECT value_json FROM channel_runtime_state WHERE key = ${key}
            `;
            const current = rows[0] === undefined ? undefined : decodeBot(rows[0].value_json);
            if (current === undefined || current.bot.threadId !== input.previousThreadId) {
              return current?.bot ?? input.bot;
            }
            yield* sql`
              UPDATE channel_runtime_state SET value_json = ${encodeBot({
                bot: input.bot,
                ...(current.legacyThreadId === undefined
                  ? {}
                  : { legacyThreadId: current.legacyThreadId }),
              })}, updated_at = ${input.now}
              WHERE key = ${key}
            `;
            return input.bot;
          }),
        )
        .pipe(Effect.mapError(toLedgerError("replaceBot"))),

    findIdentity: (input) =>
      sql<IdentityRow>`
        SELECT owner_id, principal_id, display_name, runtime_mode_ceiling, granted_scopes_json
        FROM channel_identities
        WHERE connection_id = ${input.connectionId} AND external_actor_id = ${input.externalActorId}
      `.pipe(
        Effect.map((rows) => (rows[0] === undefined ? undefined : toIdentity(rows[0]))),
        Effect.mapError(toLedgerError("findIdentity")),
      ),

    createIdentityLink: (input) =>
      sql`
        INSERT INTO channel_identity_links (
          code_hash, connection_id, owner_id, principal_id, display_name, runtime_mode_ceiling,
          granted_scopes_json, expires_at, created_at
        ) VALUES (
          ${input.codeHash}, ${input.connectionId}, ${input.identity.ownerId},
          ${input.identity.principalId}, ${input.identity.displayName},
          ${input.identity.runtimeModeCeiling}, ${encodeScopes(input.identity.grantedScopes)},
          ${input.expiresAt}, ${input.now}
        )
      `.pipe(Effect.asVoid, Effect.mapError(toLedgerError("createIdentityLink"))),

    consumeIdentityLink: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<IdentityRow>`
              UPDATE channel_identity_links SET consumed_at = ${input.now}
              WHERE code_hash = ${input.codeHash} AND connection_id = ${input.connectionId}
                AND consumed_at IS NULL AND expires_at > ${input.now}
              RETURNING owner_id, principal_id, display_name, runtime_mode_ceiling,
                granted_scopes_json
            `;
            const row = rows[0];
            if (row === undefined) {
              yield* insertDeliveries([input.failureNotice], input.now);
              return { type: "invalid" as const };
            }
            yield* sql`
              INSERT INTO channel_identities (
                connection_id, external_actor_id, owner_id, principal_id, display_name,
                runtime_mode_ceiling, granted_scopes_json, linked_at
              ) VALUES (
                ${input.connectionId}, ${input.externalActorId}, ${row.owner_id},
                ${row.principal_id}, ${row.display_name}, ${row.runtime_mode_ceiling},
                ${row.granted_scopes_json}, ${input.now}
              )
              ON CONFLICT (connection_id, external_actor_id) DO UPDATE SET
                owner_id = excluded.owner_id, principal_id = excluded.principal_id,
                display_name = excluded.display_name,
                runtime_mode_ceiling = excluded.runtime_mode_ceiling,
                granted_scopes_json = excluded.granted_scopes_json, linked_at = excluded.linked_at
            `;
            yield* insertDeliveries([input.notice], input.now);
            return { type: "linked" as const, linkedAt: input.now, identity: toIdentity(row) };
          }),
        )
        .pipe(Effect.mapError(toLedgerError("consumeIdentityLink"))),

    unlinkIdentity: (input) =>
      sql<{ readonly connection_id: string }>`
        DELETE FROM channel_identities
        WHERE connection_id = ${input.connectionId} AND external_actor_id = ${input.externalActorId}
        RETURNING connection_id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(toLedgerError("unlinkIdentity")),
      ),
  });
});

export const layer = Layer.effect(ChannelLedger, make);
