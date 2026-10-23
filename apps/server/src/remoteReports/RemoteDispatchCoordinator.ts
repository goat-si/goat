// @effect-diagnostics nodeBuiltinImport:off - generate private read keys and identify the origin machine.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import {
  ChannelWorkerObservation,
  MemoryTaskGrantCeiling,
  CommandId,
  MessageId,
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  RuntimeMode,
  IsoDateTime,
  RemoteDispatchState,
  RemoteReportDeliveryMode,
  RemoteReportKind,
  RemoteOriginReportsWaitResult,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadSendResult,
  OrchestrationV2RunStatus,
  type ChannelWorkerObservation as ChannelWorkerObservationType,
  type RemoteDispatchView,
  type RemoteRelaySend,
  type RemoteReport,
  type RemoteObservedRun,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as LaunchWatchService from "../mcp/LaunchWatchService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  RemoteTaskError,
  recordRemoteTaskProgress,
  recordRemoteTaskResult,
  importRemoteTaskClaim,
  waitForRemoteTask,
  observeRemoteTask,
  replayRemoteTaskCancel,
  requestRemoteTaskCancel,
  recoverUnknownRemoteTaskLaunch,
} from "./recordRemoteTaskResult.ts";
import * as RemoteDispatchRow from "./remoteDispatchRow.ts";
import {
  REPORTING_NOTE,
  frameLiteral,
  frameRelayOutcome,
  frameRemoteReport,
  remoteTaskQuestionNotice,
} from "./reportFrame.ts";

export class RemoteDispatchError extends Schema.TaggedError<RemoteDispatchError>()(
  "RemoteDispatchError",
  {
    stage: Schema.Literals([
      "storage",
      "decode",
      "delivery",
      "unsupported_task",
      "not_found",
      "launch",
    ]),
    reason: Schema.optional(Schema.Literal("duplicate_task")),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Remote dispatch operation failed.";
  }
}
type Row = RemoteDispatchRow.RemoteDispatchRow;

const RELAY_REQUEST_OUTCOME_LIMIT = 1_000;
const decodeRows = RemoteDispatchRow.decodeRemoteDispatchRows;
const encodeRequestIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(RuntimeRequestId)));
const encodeObservation = Schema.encodeSync(Schema.fromJsonString(ChannelWorkerObservation));
const decodeReportWait = Schema.decodeUnknownEffect(RemoteOriginReportsWaitResult);
const decodeSend = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);
const decodeFailure = (cause: unknown) => new RemoteDispatchError({ stage: "decode", cause });
const isRemoteTaskError = Schema.is(RemoteTaskError);
const isRemoteDispatchError = Schema.is(RemoteDispatchError);
const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);
const MISSING_RUN_GRACE_MS = 300_000;
/** What the launcher is told about one relayed send, and whether it is woken for it. */
type RelayOutcome = { readonly wake: boolean; readonly text: string };
export interface RemoteDispatchRecord {
  readonly memoryGrantCeiling: MemoryTaskGrantCeiling;
  readonly correlationId: string;
  readonly kind: "thread" | "task";
  readonly originThreadId: ThreadId;
  readonly host: string;
  readonly remoteThreadId: string | null;
  readonly launchedRunId: RunId | null;
  readonly delivery: typeof RemoteReportDeliveryMode.Type;
  readonly reportsSupported: boolean;
  readonly state: typeof RemoteDispatchState.Type;
  readonly reportCursor: number;
  readonly knownRunId: RunId | null;
  readonly knownRunStatus: typeof OrchestrationV2RunStatus.Type | null;
  readonly latestKind: typeof RemoteReportKind.Type | null;
  readonly latestSummary: string | null;
  readonly latestAt: string | null;
  readonly cancelRequestedAt: string | null;
  readonly cancelCeiling: RuntimeMode | null;
  readonly task: { readonly taskId: NodeId; readonly parentRunId: RunId } | null;
  /** The launched task run's open questions, as last observed. */
  readonly pendingRequestIds: ReadonlyArray<RuntimeRequestId>;
  /** The launched task run's last observation, echoed so a wait releases once per change. */
  readonly observation: ChannelWorkerObservationType | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
const publicRow = (r: Row): RemoteDispatchRecord => ({
  memoryGrantCeiling: r.memory_grant_ceiling ?? "none",
  correlationId: r.correlation_id,
  kind: r.kind,
  originThreadId: r.origin_thread_id,
  host: r.host,
  remoteThreadId: r.remote_thread_id,
  launchedRunId: r.launched_run_id,
  delivery: r.delivery,
  reportsSupported: r.reports_supported === 1,
  state: r.state,
  reportCursor: r.report_cursor,
  knownRunId: r.known_run_id,
  knownRunStatus: r.known_run_status,
  latestKind: r.latest_kind,
  latestSummary: r.latest_summary,
  latestAt: r.latest_at,
  cancelRequestedAt: r.cancel_requested_at,
  cancelCeiling: r.cancel_ceiling,
  task:
    r.task_id !== null && r.parent_run_id !== null
      ? { taskId: r.task_id, parentRunId: r.parent_run_id }
      : null,
  pendingRequestIds: r.pending_request_ids ?? [],
  observation: r.observation ?? null,
  lastError: r.last_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
export const dispatchView = (r: RemoteDispatchRecord): RemoteDispatchView => ({
  correlationId: r.correlationId,
  host: r.host,
  threadId: r.remoteThreadId,
  kind: r.kind,
  delivery: r.delivery,
  state: r.state,
  reportsSupported: r.reportsSupported,
  latest:
    r.latestKind !== null && r.latestSummary !== null && r.latestAt !== null
      ? { kind: r.latestKind, summary: r.latestSummary, at: r.latestAt }
      : null,
  lastError: r.lastError,
  createdAt: r.createdAt,
});
export interface RemoteLaunchInput {
  readonly kind: "thread" | "task";
  readonly originThreadId: ThreadId;
  readonly delivery: typeof RemoteReportDeliveryMode.Type;
  readonly launch: SshRemoteDispatch.SshLaunchInput;
  readonly task?: { readonly taskId: NodeId; readonly parentRunId: RunId };
  /** A durable caller identity (a channel child-work record) keys the row for launch retries. */
  readonly correlationId?: string | undefined;
}
export class RemoteDispatchCoordinator extends Context.Service<
  RemoteDispatchCoordinator,
  {
    readonly launch: <E, R>(
      input: RemoteLaunchInput,
      beforeLaunch: Effect.Effect<void, E, R>,
    ) => Effect.Effect<
      {
        correlationId: string;
        launch: SshRemoteDispatch.SshLaunchResult;
        reportsSupported: boolean;
      },
      RemoteDispatchError | SshRemoteDispatch.SshRemoteDispatchError | E,
      R
    >;
    readonly cancel: <E, R>(
      id: string,
      authorize: Effect.Effect<RuntimeMode, E, R>,
    ) => Effect.Effect<
      "cancel_requested" | "cancelled" | "already_settled",
      RemoteDispatchError | SshRemoteDispatch.SshRemoteDispatchError | E,
      R
    >;
    readonly get: (id: string) => Effect.Effect<RemoteDispatchRecord | null, RemoteDispatchError>;
    readonly listForOrigin: (
      id: ThreadId,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<RemoteDispatchRecord>, RemoteDispatchError>;
    /** Every origin's dispatches, most recently updated first. */
    readonly listRecent: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<RemoteDispatchRecord>, RemoteDispatchError>;
    /** The task owner remains available after completion, including for sends from other threads. */
    readonly taskOrigin: (
      host: string,
      threadId: string,
    ) => Effect.Effect<ThreadId | null, RemoteDispatchError>;
    readonly isTaskThread: (
      host: string,
      threadId: string,
    ) => Effect.Effect<boolean, RemoteDispatchError>;
    readonly resume: (host: string, threadId: string) => Effect.Effect<void, RemoteDispatchError>;
  }
>()("goat/remoteReports/RemoteDispatchCoordinator") {}

const terminal = (status: string) =>
  ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ssh = yield* SshRemoteDispatch.SshRemoteDispatch;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launchWatches = yield* LaunchWatchService.LaunchWatchService;
  const inFlight = new Map<string, Deferred.Deferred<void, RemoteDispatchError>>();
  const drains = yield* FiberMap.make<string, void, RemoteDispatchError>();
  const hosts = new Map<string, Semaphore.Semaphore>();
  const taskHosts = new Map<string, Semaphore.Semaphore>();
  // Relayed sends must not wait behind report long-polls to the same host.
  const relayHosts = new Map<string, Semaphore.Semaphore>();
  const locks = new Map<string, Semaphore.Semaphore>();
  const gate = (map: Map<string, Semaphore.Semaphore>, id: string, permits: number) => {
    const held = map.get(id);
    if (held !== undefined) return held;
    const created = Semaphore.makeUnsafe(permits);
    map.set(id, created);
    return created;
  };
  const db = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new RemoteDispatchError({ stage: "storage", cause })));
  const rows = <E>(statement: Effect.Effect<ReadonlyArray<unknown>, E>) =>
    statement.pipe(Effect.flatMap(decodeRows), db);
  const taskOrigin = (host: string, threadId: string) =>
    rows(
      sql`SELECT * FROM remote_dispatches WHERE kind = 'task' AND host = ${host} AND remote_thread_id = ${threadId} LIMIT 1`,
    ).pipe(Effect.map((matches) => matches[0]?.origin_thread_id ?? null));
  const load = (id: string) =>
    rows(sql`SELECT * FROM remote_dispatches
    WHERE correlation_id = ${id}`).pipe(Effect.map((values) => values[0] ?? null));
  const call = (r: Row, tool: string, args: Readonly<Record<string, unknown>>) =>
    gate(hosts, r.host, 8).withPermits(1)(
      ssh.callHostTool(
        {
          host: r.host,
          tool,
          arguments: args,
          writes: false,
          timeoutMs: 360_000,
        },
        Effect.succeed("approval-required"),
      ),
    );
  const taskEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(SshRemoteDispatch.SshRemoteDispatch, ssh),
      Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      Effect.catchIf(isRemoteTaskError, (error) =>
        Effect.fail(new RemoteDispatchError({ stage: error.stage, cause: error })),
      ),
    );
  const taskRecord = (r: Row) => {
    const record = publicRow(r);
    if (record.task === null) throw new Error("Decoded task row has no task association");
    return { ...record, task: record.task };
  };
  const importTaskBatch = Effect.fn("RemoteDispatchCoordinator.importTaskBatch")(function* (
    id: string,
    reports: ReadonlyArray<RemoteReport>,
    observed: RemoteObservedRun | null,
    hasMore: boolean,
  ) {
    yield* gate(locks, id, 1).withPermits(1)(
      Effect.gen(function* () {
        const r = yield* load(id);
        if (r === null || r.kind !== "task" || r.state !== "running") return;
        const record = taskRecord(r);
        const fresh = [...reports]
          .filter((p) => p.sequence > r.report_cursor)
          .sort((a, b) => a.sequence - b.sequence);
        const latestNeedsInput = fresh.findLast(
          (report) => report.kind === "needs_input" && report.runId === r.launched_run_id,
        );
        const inbox: Array<string> = [];
        for (const report of fresh) {
          const needsInput = yield* taskEffect(importRemoteTaskClaim(record, report));
          if (needsInput && r.delivery === "wake" && report !== latestNeedsInput)
            inbox.push(
              frameRemoteReport({
                host: r.host,
                correlationId: id,
                kind: report.kind,
                summary: report.summary,
                source: "agent",
              }),
            );
          if (needsInput && r.delivery === "wake" && report === latestNeedsInput)
            yield* threads
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`server:remote-report:${id}:seq:${report.sequence}`),
                threadId: r.origin_thread_id,
                messageId: MessageId.make(`message:remote-report:${id}:seq:${report.sequence}`),
                text: frameRemoteReport({
                  host: r.host,
                  correlationId: id,
                  kind: report.kind,
                  summary: report.summary,
                  source: "agent",
                }),
                attachments: [],
                createdBy: "agent",
                creationSource: "server",
                notification: {
                  source: { kind: "monitor" },
                  outcome: "updated",
                  summary: `${r.host}: needs_input`,
                },
                dispatchMode: { type: "queue_after_active" },
              })
              .pipe(
                Effect.mapError((cause) => new RemoteDispatchError({ stage: "delivery", cause })),
              );
        }
        // The launched run's open questions, when the host reports them; a finished run has none.
        const questions =
          observed === null || observed.runId !== r.launched_run_id
            ? undefined
            : terminal(observed.status)
              ? []
              : observed.pendingRequestIds;
        if (questions !== undefined) {
          // Recorded before the notices, so a task read they wake already sees the questions.
          yield* db(sql`UPDATE remote_dispatches SET
            pending_request_ids = ${questions.length === 0 ? null : encodeRequestIds(questions)}
            WHERE correlation_id = ${id}`);
          // Each question is announced once: the command ids repeat on every later pass.
          for (const requestId of questions) {
            yield* taskEffect(
              recordRemoteTaskProgress(
                record,
                `question:${requestId}`,
                `needs_input: waiting on question ${requestId}`,
              ),
            );
            if (r.delivery !== "wake" || r.remote_thread_id === null) continue;
            yield* threads
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`server:remote-task-question:${id}:${requestId}`),
                threadId: r.origin_thread_id,
                messageId: MessageId.make(`message:remote-task-question:${id}:${requestId}`),
                text: remoteTaskQuestionNotice({
                  host: r.host,
                  taskId: record.task.taskId,
                  threadId: r.remote_thread_id,
                  requestId,
                }),
                attachments: [],
                createdBy: "agent",
                creationSource: "server",
                notification: {
                  source: { kind: "monitor" },
                  outcome: "updated",
                  summary: `${r.host}: question`,
                },
                dispatchMode: { type: "queue_after_active" },
              })
              .pipe(
                Effect.mapError((cause) => new RemoteDispatchError({ stage: "delivery", cause })),
              );
          }
        }
        // Claims/monitor commands commit first; result only after the entire backlog.
        const next = hasMore ? null : yield* taskEffect(observeRemoteTask(record, observed));
        const at = yield* now;
        const last = fresh.at(-1);
        const known =
          observed !== null &&
          observed.runId === r.launched_run_id &&
          (!terminal(observed.status) || !hasMore)
            ? observed
            : null;
        const state = next ?? "running";
        yield* db(
          sql.withTransaction(
            Effect.gen(function* () {
              for (const text of inbox)
                yield* sql`INSERT INTO remote_report_inbox
                (origin_thread_id, correlation_id, kind, text, created_at)
                VALUES (${r.origin_thread_id}, ${id}, 'needs_input', ${text}, ${at})`;
              yield* sql`UPDATE remote_dispatches SET
      report_cursor = ${last?.sequence ?? r.report_cursor},
      known_run_id = ${known?.runId ?? r.known_run_id}, known_run_status = ${known?.status ?? r.known_run_status},
      latest_kind = ${last?.kind ?? r.latest_kind}, latest_summary = ${last?.summary ?? r.latest_summary},
      latest_at = ${last?.createdAt ?? r.latest_at}, state = ${state}, updated_at = ${at},
      last_error = NULL
      WHERE correlation_id = ${id}`;
              // Only the launched run's observation. A later run, or an older remote that sends
              // none, leaves the previous report in place or clears it.
              if (observed !== null && observed.runId === r.launched_run_id) {
                yield* sql`UPDATE remote_dispatches SET
                  observation = ${observed.observation === undefined ? null : encodeObservation(observed.observation)}
                  WHERE correlation_id = ${id}`;
              }
            }),
          ),
        );
      }),
    );
  });

  type Entry = {
    readonly report: RemoteReport;
    readonly key: string;
    readonly source: "agent" | "runtime";
  };
  /**
   * Delivers a send the remote thread could not make, as its launcher thread. As for
   * the launcher's own sends, the launcher must be live and in default interaction
   * mode, and its runtime mode is the ceiling the target host enforces. Only a
   * dispatch this machine launched with relaySend relays.
   *
   * The target dedupes clientRequestId per SSH session, which a restart replaces, so
   * a relay is marked attempted before it is sent. A replay after a restart reports an
   * uncertain outcome instead of sending again; a retry in this process reuses the
   * outcome it already has.
   */
  const relayOutcomes = new Map<string, RelayOutcome>();
  // Keyed by the caller's request id for retries after a lost response; bounded, oldest first out.
  const relayRequestOutcomes = new Map<string, RelayOutcome>();
  const relay = Effect.fn("RemoteDispatchCoordinator.relay")(function* (
    r: Row,
    report: RemoteReport,
    send: RemoteRelaySend,
  ) {
    const key = `${r.correlation_id}:${report.sequence}`;
    const requestKey =
      send.clientRequestId === undefined
        ? undefined
        : [r.correlation_id, send.host, send.threadId, send.clientRequestId]
            .map(encodeURIComponent)
            .join(":");
    const known =
      relayOutcomes.get(key) ??
      (requestKey === undefined ? undefined : relayRequestOutcomes.get(requestKey));
    if (known !== undefined) return known;
    const outcome = (
      status: string,
      wake: boolean,
      quoted?: { readonly reason: string; readonly message: string },
    ): RelayOutcome => ({
      wake,
      text: frameRelayOutcome({
        host: r.host,
        correlationId: r.correlation_id,
        target: { host: send.host, threadId: send.threadId },
        status,
        ...quoted,
      }),
    });
    const notDelivered = (reason: string) =>
      outcome("Not delivered. Send it yourself if it should still go.", true, {
        reason,
        message: send.message,
      });
    const uncertain = (reason: string) =>
      outcome(
        "It may have been delivered. Check the target with goat_thread_read before sending it again.",
        true,
        { reason, message: send.message },
      );
    const decided = yield* Effect.gen(function* () {
      if (r.relay_send !== 1) return notDelivered("This launch did not offer to relay sends.");
      if (report.sequence <= r.relay_attempted)
        return uncertain("GOAT stopped while it was delivering this send.");
      yield* db(sql`UPDATE remote_dispatches SET relay_attempted = ${report.sequence}
        WHERE correlation_id = ${r.correlation_id}`);
      const refused = (code: OrchestratorMcpFailure["code"], message: string) =>
        new OrchestratorMcpFailure({ code, message });
      const reviewAllowed = taskOrigin(send.host, send.threadId).pipe(
        Effect.mapError((error) => refused("orchestration_error", error.message)),
        Effect.flatMap((originThreadId) =>
          originThreadId === null
            ? Effect.void
            : threads
                .assertReviewTaskSendAllowed({
                  threadId: send.threadId,
                  senderThreadId: originThreadId,
                  host: send.host,
                  createdBy: "agent",
                })
                .pipe(
                  Effect.mapError((error) =>
                    refused(
                      error._tag === "ThreadManagementReviewTaskFinishedError"
                        ? "thread_not_sendable"
                        : "orchestration_error",
                      error.message,
                    ),
                  ),
                ),
        ),
      );
      const launcherMode = threads.getThreadShell(r.origin_thread_id).pipe(
        Effect.mapError(() =>
          refused("orchestration_error", "The launcher thread could not be read."),
        ),
        Effect.flatMap((shell) =>
          shell === null || shell.deletedAt !== null || shell.archivedAt !== null
            ? Effect.fail(refused("thread_not_found", "The launcher thread is gone."))
            : shell.interactionMode !== "default"
              ? Effect.fail(
                  refused(
                    "interaction_mode_escalation_denied",
                    `Relaying needs the launcher thread in default interaction mode; it is in ${shell.interactionMode} mode.`,
                  ),
                )
              : Effect.succeed(shell.runtimeMode),
        ),
      );
      const requestKey =
        send.clientRequestId === undefined
          ? `seq:${report.sequence}`
          : `req:${NodeCrypto.createHash("sha256").update(send.clientRequestId).digest("hex").slice(0, 32)}`;
      const sent = yield* gate(relayHosts, send.host, 4)
        .withPermits(1)(
          ssh.callHostTool(
            {
              host: send.host,
              tool: "goat_thread_send",
              arguments: {
                threadId: send.threadId,
                message: send.message,
                // From a thread, queue and steer mean "like steering", which a remote's auto does.
                ...(send.mode === undefined
                  ? {}
                  : { mode: send.mode === "restart" ? "restart" : "auto" }),
                clientRequestId: `relay:${r.correlation_id}:${requestKey}`,
              },
              writes: true,
              timeoutMs: 120_000,
            },
            reviewAllowed.pipe(Effect.andThen(launcherMode)),
          ),
        )
        .pipe(Effect.flatMap(decodeSend), Effect.result);
      if (sent._tag === "Failure") {
        const error = sent.failure;
        if (isOrchestratorMcpFailure(error)) return notDelivered(error.message);
        if (!(error instanceof SshRemoteDispatch.SshRemoteDispatchError))
          return uncertain("The target returned a result goat_thread_send could not read.");
        // Refused before anything was sent, or by the target with a reason of its own.
        // A lost answer, or a target that failed after accepting it, may still have it.
        const refusedBeforeSending =
          error.reason === "host_unknown" ||
          error.reason === "invalid_request" ||
          error.reason === "caller_changed" ||
          (error.reason === "remote_refused" &&
            error.remoteCode !== undefined &&
            error.remoteCode !== "orchestration_error");
        return refusedBeforeSending ? notDelivered(error.message) : uncertain(error.message);
      }
      const result = sent.success;
      if (result.delivery === "relayed")
        return outcome(`Handed on again to ${frameLiteral(result.via)}.`, false);
      // As after the launcher's own send: a watch hears when this run ends, and a
      // dispatch to that thread follows its reports again.
      yield* launchWatches
        .rearm({
          launcherThreadId: r.origin_thread_id,
          host: send.host,
          threadId: send.threadId,
          runId: result.runId,
        })
        .pipe(Effect.catch(() => Effect.logWarning("launch watch: relayed send not followed")));
      yield* resume(send.host, send.threadId).pipe(
        Effect.catch(() => Effect.logWarning("Could not resume SSH report observation.")),
      );
      return outcome(`Delivered: ${result.delivery}, run ${frameLiteral(result.runId)}.`, false);
    });
    relayOutcomes.set(key, decided);
    if (requestKey !== undefined) {
      relayRequestOutcomes.set(requestKey, decided);
      if (relayRequestOutcomes.size > RELAY_REQUEST_OUTCOME_LIMIT) {
        const oldest = relayRequestOutcomes.keys().next().value;
        if (oldest !== undefined) relayRequestOutcomes.delete(oldest);
      }
    }
    return decided;
  });
  const importBatch = Effect.fn("RemoteDispatchCoordinator.importBatch")(function* (
    id: string,
    reports: ReadonlyArray<RemoteReport>,
    observed: RemoteObservedRun | null,
    hasMore: boolean,
    forced?: "lost",
    waitingForRun = false,
  ) {
    const existing = yield* load(id);
    if (existing?.kind === "task") return yield* importTaskBatch(id, reports, observed, hasMore);
    yield* gate(locks, id, 1).withPermits(1)(
      Effect.gen(function* () {
        const r = yield* load(id);
        if (r === null || r.kind !== "thread" || (r.state !== "running" && forced === undefined))
          return;
        const at = yield* now;
        const fresh = [...reports]
          .filter((p) => p.sequence > r.report_cursor)
          .sort((a, b) => a.sequence - b.sequence);
        const entries: Entry[] = fresh
          .map((report): Entry => ({
            report,
            key: `seq:${report.sequence}`,
            source: forced === "lost" ? "runtime" : "agent",
          }))
          .filter((entry) => entry.report.relay === undefined);
        const ended = observed !== null && terminal(observed.status) && !hasMore;
        // The launch watch owns run-end wakes. Observation only settles this ledger.
        const inbox: Array<{ kind: typeof RemoteReportKind.Type | "relay"; text: string }> = [];
        const latestNeedsInput = entries.findLast((entry) => entry.report.kind === "needs_input");
        for (const entry of entries) {
          const text = frameRemoteReport({
            host: r.host,
            correlationId: id,
            kind: entry.report.kind,
            summary: entry.report.summary,
            source: entry.source,
          });
          if (r.delivery === "wake" && entry === latestNeedsInput) {
            yield* threads
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`server:remote-report:${id}:${entry.key}`),
                threadId: r.origin_thread_id,
                messageId: MessageId.make(`message:remote-report:${id}:${entry.key}`),
                text,
                attachments: [],
                createdBy: "agent",
                creationSource: "server",
                notification: {
                  source: { kind: "monitor" },
                  outcome: "updated",
                  summary: `${r.host}: ${entry.report.kind}`,
                },
                dispatchMode: { type: "queue_after_active" },
              })
              .pipe(
                Effect.mapError((cause) => new RemoteDispatchError({ stage: "delivery", cause })),
              );
          } else if (r.delivery !== "notify_only") inbox.push({ kind: entry.report.kind, text });
        }
        // Only a binding this machine declared relaySend for carries relays.
        for (const report of forced === undefined ? fresh : []) {
          if (report.relay === undefined) continue;
          const outcome = yield* relay(r, report, report.relay);
          if (r.delivery === "wake" && outcome.wake) {
            yield* threads
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`server:remote-relay:${id}:seq:${report.sequence}`),
                threadId: r.origin_thread_id,
                messageId: MessageId.make(`message:remote-relay:${id}:seq:${report.sequence}`),
                text: outcome.text,
                attachments: [],
                createdBy: "agent",
                creationSource: "server",
                notification: {
                  source: { kind: "monitor" },
                  outcome: "updated",
                  summary: `${r.host}: relay not delivered`,
                },
                dispatchMode: { type: "queue_after_active" },
              })
              .pipe(
                Effect.mapError((cause) => new RemoteDispatchError({ stage: "delivery", cause })),
              );
          } else if (r.delivery !== "notify_only")
            inbox.push({ kind: "relay", text: outcome.text });
        }
        // No SQLite transaction encloses notification I/O. Its deterministic receipt
        // dedupes a crash here; SQL then atomically imports inbox + ledger + cursor.
        yield* db(
          sql.withTransaction(
            Effect.gen(function* () {
              for (const entry of inbox) {
                if (entry.kind === "progress")
                  yield* sql`DELETE FROM remote_report_inbox
            WHERE origin_thread_id = ${r.origin_thread_id} AND correlation_id = ${id} AND kind = 'progress'`;
                yield* sql`INSERT INTO remote_report_inbox
            (origin_thread_id, correlation_id, kind, text, created_at)
            VALUES (${r.origin_thread_id}, ${id}, ${entry.kind}, ${entry.text}, ${at})`;
              }
              const last = entries.at(-1)?.report;
              const cursor = fresh.at(-1)?.sequence ?? r.report_cursor;
              // Import every page before persisting a terminal known state.
              const known =
                observed !== null && (!terminal(observed.status) || !hasMore) ? observed : null;
              const state =
                forced ??
                (hasMore
                  ? "running"
                  : ended
                    ? r.cancel_requested_at !== null
                      ? "cancelled"
                      : "settled"
                    : observed === null
                      ? r.cancel_requested_at !== null
                        ? "cancelled"
                        : waitingForRun
                          ? "running"
                          : "idle"
                      : "running");
              yield* sql`UPDATE remote_dispatches SET report_cursor = ${cursor},
          known_run_id = ${known?.runId ?? r.known_run_id},
          known_run_status = ${known?.status ?? r.known_run_status},
          latest_kind = ${last?.kind ?? r.latest_kind}, latest_summary = ${last?.summary ?? r.latest_summary},
          latest_at = ${last?.createdAt ?? r.latest_at}, state = ${state}, updated_at = ${at},
          last_error = ${forced === "lost" ? "Remote report binding or thread is unavailable." : null}
          WHERE correlation_id = ${id}`;
            }),
          ),
        );
        // Imported: the cursor now skips these relays, so their outcomes are no longer needed.
        for (const report of fresh) relayOutcomes.delete(`${id}:${report.sequence}`);
      }),
    );
  });
  const observe = Effect.fn("RemoteDispatchCoordinator.observe")(function* (r: Row) {
    if (r.kind === "task")
      return yield* gate(taskHosts, r.host, 32).withPermits(1)(
        taskEffect(
          waitForRemoteTask({
            row: taskRecord(r),
            reportsSupported: r.reports_supported === 1,
            readKey: r.read_key,
            afterSequence: r.report_cursor,
            knownRun:
              r.known_run_id === null || r.known_run_status === null
                ? null
                : {
                    runId: r.known_run_id,
                    status: r.known_run_status,
                    // Echoed back so an open question releases the wait once, not every call.
                    pendingRequestIds: r.pending_request_ids ?? [],
                    // Omitted when unset, so an older remote is not released on every call.
                    ...(r.observation == null ? {} : { observation: r.observation }),
                  },
          }),
        ),
      );
    const answer = yield* call(r, "goat_origin_reports_wait", {
      correlationId: r.correlation_id,
      readKey: r.read_key,
      afterSequence: r.report_cursor,
      watchRunId: null,
      knownRun:
        r.known_run_id === null || r.known_run_status === null
          ? null
          : { runId: r.known_run_id, status: r.known_run_status },
      timeoutMs: 300_000,
    }).pipe(
      Effect.flatMap(decodeReportWait),
      Effect.mapError((cause) =>
        cause instanceof SshRemoteDispatch.SshRemoteDispatchError ? cause : decodeFailure(cause),
      ),
    );
    if (answer.threadId !== r.remote_thread_id)
      return yield* new RemoteDispatchError({ stage: "decode" });
    return answer;
  });
  const drain = Effect.fn("RemoteDispatchCoordinator.drain")(function* (
    id: string,
    waitForRun: boolean,
    interruptSent = false,
  ) {
    const runDeadline = (yield* Clock.currentTimeMillis) + (waitForRun ? MISSING_RUN_GRACE_MS : 0);
    let backoff = 5_000;
    let hostFailures = 0;
    let outageNotified = false;
    while (true) {
      const keepDraining = yield* Effect.gen(function* () {
        const r = yield* load(id);
        if (
          r === null ||
          r.state !== "running" ||
          (r.kind === "thread" && r.reports_supported !== 1)
        )
          return false;
        const shell = yield* threads
          .getThreadShell(r.origin_thread_id)
          .pipe(Effect.mapError((cause) => new RemoteDispatchError({ stage: "storage", cause })));
        if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null) {
          if (r.kind === "task")
            yield* taskEffect(
              recordRemoteTaskResult({
                ...taskRecord(r),
                status: "failed",
                summary: "The remote task's thread or report binding is unavailable.",
              }),
            );
          yield* db(sql`UPDATE remote_dispatches SET state = ${r.kind === "task" ? "lost" : "settled"}, last_error = ${r.kind === "task" ? "Origin thread is unavailable." : null}, updated_at = ${yield* now}
          WHERE correlation_id = ${id}`);
          return false;
        }
        let cancelPending = false;
        const answer = yield* Effect.gen(function* () {
          if (r.kind === "task")
            yield* taskEffect(
              recordRemoteTaskProgress(taskRecord(r), "launched", "Remote task launched."),
            );
          if (r.kind === "task" && r.cancel_requested_at !== null && !interruptSent) {
            const interrupted = yield* taskEffect(replayRemoteTaskCancel(taskRecord(r))).pipe(
              Effect.result,
            );
            interruptSent = interrupted._tag === "Success";
            cancelPending = !interruptSent;
            if (cancelPending)
              yield* db(
                sql`UPDATE remote_dispatches SET last_error = 'cancel pending: interrupt refused or unavailable', updated_at = ${yield* now} WHERE correlation_id = ${id}`,
              );
          }
          return yield* observe(r);
        }).pipe(Effect.result);
        if (answer._tag === "Failure") {
          const error = answer.failure;
          if (
            error instanceof SshRemoteDispatch.SshRemoteDispatchError &&
            (error.reason === "host_unavailable" || error.reason === "ssh_failed")
          ) {
            hostFailures += 1;
            if (r.kind === "task" && hostFailures >= 3 && !outageNotified) {
              yield* threads
                .dispatch({
                  type: "message.dispatch",
                  commandId: CommandId.make(`server:remote-task-outage:${id}`),
                  threadId: r.origin_thread_id,
                  messageId: MessageId.make(`message:remote-task-outage:${id}`),
                  text: `GOAT cannot reach host ${r.host} to observe delegated task ${r.task_id}. The task remains running; use goat_task_read to follow it.`,
                  attachments: [],
                  createdBy: "agent",
                  creationSource: "server",
                  notification: {
                    source: { kind: "monitor" },
                    outcome: "updated",
                    summary: `${r.host}: remote task host unavailable`,
                  },
                  dispatchMode: { type: "queue_after_active" },
                })
                .pipe(
                  Effect.mapError((cause) => new RemoteDispatchError({ stage: "delivery", cause })),
                );
              outageNotified = true;
            }
            yield* db(sql`UPDATE remote_dispatches SET last_error = 'Host unavailable',
            updated_at = ${yield* now} WHERE correlation_id = ${id}`);
            yield* Effect.sleep(backoff);
            backoff = Math.min(300_000, backoff * 2);
            return true;
          }
          hostFailures = 0;
          if (r.kind === "task") {
            const gone =
              error instanceof SshRemoteDispatch.SshRemoteDispatchError &&
              error.reason === "remote_refused" &&
              (error.remoteCode === "capability_denied" || error.remoteCode === "thread_not_found");
            if (gone) {
              yield* taskEffect(
                recordRemoteTaskResult({
                  ...taskRecord(r),
                  status: "failed",
                  summary: "The remote task's thread or report binding is unavailable.",
                }),
              );
              yield* db(
                sql`UPDATE remote_dispatches SET state = 'lost', last_error = 'Remote task binding or thread is unavailable.', updated_at = ${yield* now} WHERE correlation_id = ${id}`,
              );
              return false;
            }
            return yield* error;
          }
          yield* importBatch(
            id,
            [
              {
                sequence: r.report_cursor + 1,
                runId: r.known_run_id,
                kind: "failed",
                summary: "GOAT lost track of the remote report binding or thread.",
                createdAt: yield* now,
              },
            ],
            null,
            false,
            "lost",
          );
          return false;
        }
        hostFailures = 0;
        const missingRun = answer.success.observedRun === null && r.launched_run_id === null;
        const waitingForRun = missingRun && (yield* Clock.currentTimeMillis) < runDeadline;
        const imported = yield* importBatch(
          id,
          answer.success.reports,
          answer.success.observedRun,
          answer.success.hasMore,
          undefined,
          waitingForRun,
        ).pipe(Effect.result);
        if (imported._tag === "Failure") {
          if (r.kind === "thread") return yield* imported.failure;
          yield* db(
            sql`UPDATE remote_dispatches SET last_error = 'Task result import pending' WHERE correlation_id = ${id}`,
          );
          yield* Effect.sleep(backoff);
          backoff = Math.min(300_000, backoff * 2);
          return true;
        }
        if (cancelPending) {
          yield* db(
            sql`UPDATE remote_dispatches SET last_error = 'cancel pending: interrupt refused or unavailable' WHERE correlation_id = ${id} AND state = 'running'`,
          );
          yield* Effect.sleep(backoff);
          backoff = Math.min(300_000, backoff * 2);
        } else if (waitingForRun) {
          yield* Effect.sleep(Math.min(backoff, runDeadline - (yield* Clock.currentTimeMillis)));
          backoff = Math.min(300_000, backoff * 2);
        } else backoff = 5_000;
        return true;
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
          // A transport or SQL cause can carry private arguments. Log only a fixed category.
          return Effect.gen(function* () {
            yield* Effect.logWarning("Remote report drain failed; retrying.", {
              correlationId: id,
            });
            yield* db(sql`UPDATE remote_dispatches SET last_error = 'Report delivery or storage failed; retrying.',
            updated_at = ${yield* now} WHERE correlation_id = ${id}`).pipe(
              Effect.catchCause(() => Effect.void),
            );
            yield* Effect.sleep(backoff);
            backoff = Math.min(300_000, backoff * 2);
            return true;
          });
        }),
      );
      if (!keepDraining) return;
    }
  });
  // Replace a finishing poller as well: resume/cancel must never lose their restart.
  const start = (id: string, waitForRun = false, interruptSent = false) =>
    FiberMap.run(
      drains,
      id,
      drain(id, waitForRun, interruptSent).pipe(
        Effect.mapError((cause) =>
          isRemoteDispatchError(cause)
            ? cause
            : new RemoteDispatchError({ stage: "delivery", cause }),
        ),
      ),
    ).pipe(Effect.asVoid);
  const launch = Effect.fn("RemoteDispatchCoordinator.launch")(function* <E, R>(
    input: RemoteLaunchInput,
    beforeLaunch: Effect.Effect<void, E, R>,
  ) {
    if ((input.kind === "task") !== (input.task !== undefined))
      return yield* new RemoteDispatchError({ stage: "unsupported_task" });
    const launchKey =
      input.task === undefined
        ? (input.correlationId ?? null)
        : `${input.originThreadId}:${input.task.taskId}`;
    const pending = launchKey === null ? undefined : inFlight.get(launchKey);
    const owner =
      pending === undefined ? yield* Deferred.make<void, RemoteDispatchError>() : pending;
    const ownsEntry = launchKey !== null && pending === undefined;
    if (ownsEntry) inFlight.set(launchKey, owner);
    return yield* Effect.gen(function* () {
      const id = input.correlationId ?? `rr-${NodeCrypto.randomUUID()}`;
      const readKey = NodeCrypto.randomBytes(32).toString("hex");
      const at = yield* now;
      const acquired = yield* db(sql`INSERT INTO remote_dispatches
        (correlation_id, kind, origin_thread_id, host, read_key, delivery, state, task_id, parent_run_id, relay_send, created_at, updated_at, memory_grant_ceiling)
        VALUES (${id}, ${input.kind}, ${input.originThreadId}, ${input.launch.host}, ${readKey}, ${input.delivery}, 'launching', ${input.task?.taskId ?? null}, ${input.task?.parentRunId ?? null}, ${input.kind === "thread" ? 1 : 0}, ${at}, ${at}, ${input.launch.memoryGrantCeiling ?? "none"})`).pipe(
        Effect.result,
      );
      if (acquired._tag === "Failure") {
        const duplicate = yield* rows(RemoteDispatchRow.findLaunchConflict(sql, input));
        if (duplicate.length === 0) return yield* acquired.failure;
        if (pending === undefined && duplicate[0]?.state !== "launching")
          return yield* new RemoteDispatchError({ stage: "launch", reason: "duplicate_task" });
        if (pending === undefined) return yield* new RemoteDispatchError({ stage: "launch" });
        yield* Deferred.await(pending);
        return yield* new RemoteDispatchError({ stage: "launch", reason: "duplicate_task" });
      }
      const stored = yield* load(id);
      if (stored === null) return yield* new RemoteDispatchError({ stage: "not_found" });
      const storedLaunch = {
        ...input.launch,
        ...(input.kind === "task" || input.launch.memoryGrantCeiling !== undefined
          ? { memoryGrantCeiling: stored.memory_grant_ceiling ?? "none" }
          : {}),
      };
      const register = beforeLaunch.pipe(Effect.tap(() => Deferred.succeed(owner, undefined)));
      const result = yield* ssh
        .launchThread(
          {
            ...storedLaunch,
            reportNote: REPORTING_NOTE,
            report: {
              correlationId: id,
              originLabel: NodeOS.hostname(),
              originThreadId: input.originThreadId,
              readKeyHash: NodeCrypto.createHash("sha256").update(readKey).digest("hex"),
              // Delegated tasks report to their parent task and do not relay.
              ...(input.kind === "thread" ? { relaySend: true } : {}),
            },
          },
          register,
        )
        .pipe(
          Effect.catch((error) => {
            if (
              !(error instanceof SshRemoteDispatch.SshRemoteDispatchError) ||
              error.reason !== "remote_refused" ||
              !/goat_thread_launch does not take (?:[^.]*, )?report\b[^.]*, so nothing ran/u.test(
                error.message,
              )
            ) {
              return Effect.fail(error);
            }
            const legacyLaunch = { ...storedLaunch };
            delete legacyLaunch.report;
            return ssh
              .launchThread(legacyLaunch, register)
              .pipe(Effect.map((value) => ({ ...value, reportsSupported: false })));
          }),
          Effect.tapError((error) =>
            Effect.gen(function* () {
              // No remote write can precede beforeLaunch. Release the task key if
              // registration never committed, so the same request can retry.
              const registered = yield* Deferred.isDone(owner);
              const refused =
                (error instanceof SshRemoteDispatch.SshRemoteDispatchError &&
                  ["remote_refused", "invalid_request", "host_unknown", "caller_changed"].includes(
                    error.reason,
                  )) ||
                (isOrchestratorMcpFailure(error) && !registered);
              if ((input.kind === "task" && !registered) || (input.kind === "thread" && refused)) {
                yield* db(sql`DELETE FROM remote_dispatches WHERE correlation_id = ${id}`);
                return;
              }
              yield* db(sql`UPDATE remote_dispatches SET state = 'lost',
      last_error = 'Launch outcome unknown or refused; check goat_thread_list with host before retrying.',
      updated_at = ${at} WHERE correlation_id = ${id}`);
            }),
          ),
        );
      yield* db(sql`UPDATE remote_dispatches SET remote_thread_id = ${result.threadId},
      launched_run_id = ${result.runId}, reports_supported = ${result.reportsSupported ? 1 : 0},
      state = ${input.kind === "task" ? (result.runId === null ? "lost" : "running") : result.reportsSupported && (result.runId !== null || input.launch.message?.trim()) ? "running" : "idle"},
      last_error = ${input.kind === "task" ? (result.runId === null ? "launch outcome unknown" : null) : result.reportsSupported ? null : "This host does not support reports; enable the launch watch to follow run ends."},
      updated_at = ${yield* now} WHERE correlation_id = ${id}`);
      const r = yield* load(id);
      if (r?.kind === "task") {
        yield* taskEffect(
          recordRemoteTaskProgress(taskRecord(r), "launched", "Remote task launched."),
        ).pipe(
          Effect.catch(() =>
            db(
              sql`UPDATE remote_dispatches SET last_error = 'Task launch progress delivery pending' WHERE correlation_id = ${id}`,
            ),
          ),
        );
        if (r.launched_run_id !== null) yield* start(id);
        return { correlationId: id, launch: result, reportsSupported: result.reportsSupported };
      }
      if (result.reportsSupported)
        yield* start(id, result.runId === null && Boolean(input.launch.message?.trim()));
      return { correlationId: id, launch: result, reportsSupported: result.reportsSupported };
    }).pipe(
      Effect.tapError((cause) =>
        ownsEntry
          ? Deferred.fail(
              owner,
              isRemoteDispatchError(cause)
                ? cause
                : new RemoteDispatchError({ stage: "launch", cause }),
            )
          : Effect.void,
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          if (ownsEntry) {
            yield* Deferred.fail(owner, new RemoteDispatchError({ stage: "launch" }));
            inFlight.delete(launchKey);
          }
        }),
      ),
    );
  });
  const cancel = Effect.fn("RemoteDispatchCoordinator.cancel")(function* <E, R>(
    id: string,
    authorize: Effect.Effect<RuntimeMode, E, R>,
  ) {
    yield* authorize;
    const result = yield* gate(locks, id, 1).withPermits(1)(
      Effect.gen(function* () {
        const r = yield* load(id);
        if (r === null) return yield* new RemoteDispatchError({ stage: "not_found" });
        if (r.kind !== "task") return yield* new RemoteDispatchError({ stage: "unsupported_task" });
        if (r.state === "cancelled") return "cancelled" as const;
        if (r.state === "settled" || r.state === "lost") return "already_settled" as const;
        return { task: taskRecord(r) };
      }),
    );
    if (typeof result === "string") return result;
    const requested = yield* taskEffect(requestRemoteTaskCancel(result.task, authorize)).pipe(
      Effect.result,
    );
    // Keep observing even when replay is refused; durable intent remains retryable.
    if (result.task.launchedRunId !== null) yield* start(id, false, requested._tag === "Success");
    if (requested._tag === "Failure") return yield* Effect.fail(requested.failure);
    return requested.success;
  });
  // Typed here because relay calls it and drain reaches relay, which would make it circular.
  const resume: RemoteDispatchCoordinator["Service"]["resume"] = Effect.fn(
    "RemoteDispatchCoordinator.resume",
  )(function* (host: string, threadId: string) {
    const matching = yield* rows(sql`SELECT * FROM remote_dispatches WHERE host = ${host}
      AND remote_thread_id = ${threadId} AND kind = 'thread'
      AND reports_supported = 1
      AND state IN ('idle','settled','cancelled')`);
    for (const r of matching) {
      // Stop a final observation before resetting the ledger for the new send.
      yield* FiberMap.remove(drains, r.correlation_id);
      yield* gate(locks, r.correlation_id, 1).withPermits(1)(
        db(sql`UPDATE remote_dispatches SET
        state = 'running', cancel_requested_at = NULL, cancel_ceiling = NULL,
        known_run_id = NULL, known_run_status = NULL, updated_at = ${yield* now}
        WHERE correlation_id = ${r.correlation_id}`),
      );
      yield* start(r.correlation_id);
    }
  });
  const uncertainTasks = yield* rows(sql`SELECT * FROM remote_dispatches WHERE kind = 'task'
  AND state IN ('launching', 'lost')`);
  for (const r of uncertainTasks) {
    yield* Effect.gen(function* () {
      const { subagents } = yield* threads.getThreadRecords(r.origin_thread_id, ["subagents"]);
      if (subagents.some((task) => task.id === r.task_id && task.result !== null)) {
        // The result already landed; only a row stuck in launching still needs closing.
        if (r.state === "launching")
          yield* db(sql`UPDATE remote_dispatches SET state = 'lost', updated_at = ${yield* now}
          WHERE correlation_id = ${r.correlation_id}`);
        return;
      }
      if (r.launched_run_id === null)
        yield* taskEffect(recoverUnknownRemoteTaskLaunch(taskRecord(r)));
      else
        yield* taskEffect(
          recordRemoteTaskResult({
            ...taskRecord(r),
            status: "failed",
            summary: "The remote task's thread or report binding is unavailable.",
          }),
        );
      yield* db(sql`UPDATE remote_dispatches SET state = 'lost', last_error = ${r.launched_run_id === null ? "launch outcome unknown" : "Remote task binding or thread is unavailable."},
      updated_at = ${yield* now} WHERE correlation_id = ${r.correlation_id}`);
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning("Remote task recovery failed; continuing.", {
          correlationId: r.correlation_id,
        }),
      ),
    );
  }

  // Recovery precedes serving requests. Launch uncertainty never triggers a re-launch.
  yield* db(sql`UPDATE remote_dispatches SET state = 'lost',
    last_error = 'Launch outcome unknown; check goat_thread_list with host.',
    updated_at = ${yield* now} WHERE state = 'launching' AND kind = 'thread'`);
  yield* db(sql`UPDATE remote_dispatches SET state = 'idle', updated_at = ${yield* now}
    WHERE kind = 'thread' AND reports_supported = 0 AND state = 'running'`);
  const active = yield* rows(sql`SELECT * FROM remote_dispatches WHERE state = 'running'`);
  for (const r of active) yield* start(r.correlation_id, r.launched_run_id === null);
  return RemoteDispatchCoordinator.of({
    launch,
    cancel,
    resume,
    taskOrigin,
    isTaskThread: (host, threadId) =>
      db(
        sql<{
          correlation_id: string;
        }>`SELECT correlation_id FROM remote_dispatches WHERE kind = 'task' AND host = ${host} AND remote_thread_id = ${threadId} LIMIT 1`,
      ).pipe(Effect.map((matches) => matches.length > 0)),
    get: Effect.fn("RemoteDispatchCoordinator.get")((id: string) =>
      load(id).pipe(Effect.map((r) => (r === null ? null : publicRow(r)))),
    ),
    listForOrigin: Effect.fn("RemoteDispatchCoordinator.listForOrigin")(
      (id: ThreadId, limit?: number) =>
        rows(sql`SELECT * FROM remote_dispatches WHERE origin_thread_id = ${id}
        ORDER BY created_at DESC, correlation_id DESC LIMIT ${limit ?? -1}`).pipe(
          Effect.map((values) => values.map(publicRow)),
        ),
    ),
    listRecent: Effect.fn("RemoteDispatchCoordinator.listRecent")((limit: number) =>
      rows(sql`SELECT * FROM remote_dispatches
        ORDER BY updated_at DESC, correlation_id DESC LIMIT ${limit}`).pipe(
        Effect.map((values) => values.map(publicRow)),
      ),
    ),
  });
});
export const layer = Layer.effect(RemoteDispatchCoordinator, make);
