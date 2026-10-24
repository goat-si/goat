// @effect-diagnostics nodeBuiltinImport:off - read-key hashing needs a constant-time compare.
import * as NodeCrypto from "node:crypto";
import {
  channelWorkerObservationEquals,
  CommandId,
  MessageId,
  NonNegativeInt,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  ThreadId,
  type ThreadResult,
  RemoteReportBindingInput,
  RemoteReport,
  RemoteRelaySend,
  type RemoteKnownRun,
  type RemoteObservedRun,
  type RemoteReportedOutcome,
  RemoteOriginReportInput,
  RemoteOriginReportResult,
  RemoteOriginReportsWaitInput,
  RemoteOriginReportsWaitResult,
  RemoteResolveBindingInput,
  type RemoteResolveBindingResult,
  REMOTE_REPORT_SUMMARY_MAX_CHARS,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { localQuestionLauncher } from "../orchestration-v2/QuestionEscalationService.ts";
import {
  isTerminalRunStatus,
  pendingUserInputRequestIdsForRun,
} from "../orchestration-v2/ThreadManagementService.ts";
import { frameRemoteReport } from "./reportFrame.ts";
import { redactGoatCredentialsDeep } from "../mcp/goatCredentialRedaction.ts";
import { readThreadResult } from "../threadResults/ThreadResultService.ts";
import {
  completionHoldCount,
  needsYouFromRuntimeRequests,
  scanSubagents,
  observeWorker,
  pullRequestsFromLinks,
  usageLimitWait,
} from "../channels/channelWorkerObservation.ts";

export class RemoteReportError extends Schema.TaggedError<RemoteReportError>()(
  "RemoteReportError",
  {
    reason: Schema.Literals([
      "invalid_request",
      "not_bound",
      "access_denied",
      "run_not_found",
      "thread_deleted",
      "relay_unsupported",
      "relay_queue_full",
      "fenced",
      "unavailable",
      "storage",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Remote report operation failed.";
  }
}
const BindingRow = Schema.Struct({
  threadId: ThreadId,
  ...RemoteReportBindingInput.fields,
  relaySend: Schema.Number,
  lastSequence: NonNegativeInt,
});
const decodeBindingRows = Schema.decodeUnknownEffect(Schema.Array(BindingRow));
/** relay_send: 0 no relay, 1 relay (an origin older than turn capabilities), 2 relay with them. */
const RELAY_WITH_CAPABILITIES = 2;
const relaySendLevel = (value: RemoteReportBindingInput) =>
  value.relaySend !== true ? 0 : value.relayCapabilities === true ? RELAY_WITH_CAPABILITIES : 1;
const decodeBindingInput = Schema.decodeUnknownEffect(RemoteReportBindingInput);
const decodeReportInput = Schema.decodeUnknownEffect(RemoteOriginReportInput);
const decodeRelayInput = Schema.decodeUnknownEffect(RemoteRelaySend);
const decodeWaitInput = Schema.decodeUnknownEffect(RemoteOriginReportsWaitInput);
const decodeResolveInput = Schema.decodeUnknownEffect(RemoteResolveBindingInput);
const RelayJson = Schema.fromJsonString(RemoteRelaySend);
const encodeRelay = Schema.encodeSync(RelayJson);
const decodeReportRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ ...RemoteReport.fields, relay: Schema.NullOr(RelayJson) })),
);
const decodeReports = (rows: unknown) =>
  decodeReportRows(rows).pipe(
    Effect.map((values) =>
      values.map(({ relay, ...report }): RemoteReport =>
        relay === null ? report : { ...report, relay },
      ),
    ),
  );
const isRemoteReportError = Schema.is(RemoteReportError);
/** Relays the origin has not collected yet. They are never pruned, so they are capped. */
export const MAX_PENDING_RELAYS = 50;

const sameRequestIds = (
  known: ReadonlyArray<string> | undefined,
  observed: ReadonlyArray<string> | undefined,
) => known === undefined || known.join("\n") === (observed ?? []).join("\n");
const sameHolds = (known: RemoteKnownRun["holds"], observed: RemoteObservedRun["holds"]) =>
  known === undefined ||
  (known.backgroundTasks === (observed?.backgroundTasks ?? 0) &&
    known.continuationPending === (observed?.continuationPending ?? false));
const sameObservation = (
  known: RemoteKnownRun["observation"],
  observed: RemoteObservedRun["observation"],
) => known === undefined || channelWorkerObservationEquals(known, observed);
/**
 * Whether a read differs from the caller's last view. Questions, holds and the
 * observation count only when the caller sent them, so an older origin that cannot
 * echo them back is not released on every call while a question is open.
 */
export const observedRunChanged = (
  known: RemoteKnownRun | null,
  observed: RemoteObservedRun | null,
) =>
  (observed?.runId ?? null) !== (known?.runId ?? null) ||
  (observed?.status ?? null) !== (known?.status ?? null) ||
  (known !== null &&
    observed !== null &&
    (!sameRequestIds(known.pendingRequestIds, observed.pendingRequestIds) ||
      !sameHolds(known.holds, observed.holds) ||
      !sameObservation(known.observation, observed.observation)));

export class RemoteReportService extends Context.Service<
  RemoteReportService,
  {
    readonly bind: (
      threadId: ThreadId,
      input: RemoteReportBindingInput,
    ) => Effect.Effect<void, RemoteReportError>;
    readonly unbind: (threadId: ThreadId) => Effect.Effect<void, RemoteReportError>;
    /** The machine and thread this thread was launched from, when it reports to one. */
    readonly origin: (threadId: ThreadId) => Effect.Effect<
      {
        readonly originLabel: string;
        readonly originThreadId: ThreadId;
        /** The origin delivers this thread's sends to hosts it cannot reach. */
        readonly relaySend: boolean;
      } | null,
      RemoteReportError
    >;
    readonly report: (
      threadId: ThreadId,
      input: RemoteOriginReportInput,
    ) => Effect.Effect<RemoteOriginReportResult, RemoteReportError>;
    /** Asks the origin to deliver a goat_thread_send; only for a binding with relaySend. */
    /** A relay request's durable sequence, retained after its report is collected. */
    readonly relayReceipt: (
      threadId: ThreadId,
      clientRequestId: string,
    ) => Effect.Effect<
      { readonly sequence: number; readonly originLabel: string } | null,
      RemoteReportError
    >;
    readonly relay: (
      threadId: ThreadId,
      input: RemoteRelaySend,
    ) => Effect.Effect<RemoteOriginReportResult, RemoteReportError>;
    readonly wait: (
      input: RemoteOriginReportsWaitInput,
    ) => Effect.Effect<RemoteOriginReportsWaitResult, RemoteReportError>;
    /**
     * Settles a correlation whose launch outcome the origin lost: returns the binding with the
     * thread's live state, or durably fences the id so a late bind is refused. The correlation's
     * read key is the caller's credential; a fence remembers its hash for repeat callers.
     */
    readonly resolveBinding: (
      input: RemoteResolveBindingInput,
    ) => Effect.Effect<RemoteResolveBindingResult, RemoteReportError>;
  }
>()("goat/remoteReports/RemoteReportService") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const signals = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown);
  const storage = (cause: unknown) => new RemoteReportError({ reason: "storage", cause });
  const unavailable = (cause: unknown) => new RemoteReportError({ reason: "unavailable", cause });
  const invalid = (cause: unknown) => new RemoteReportError({ reason: "invalid_request", cause });
  const storageUnlessReport = (cause: unknown) =>
    isRemoteReportError(cause) ? cause : storage(cause);
  const decodeRows = decodeBindingRows;
  const bindingForThread = (threadId: ThreadId) =>
    sql`
    SELECT thread_id AS "threadId", correlation_id AS "correlationId",
      origin_label AS "originLabel", origin_thread_id AS "originThreadId",
      read_key_hash AS "readKeyHash", relay_send AS "relaySend", last_sequence AS "lastSequence"
    FROM remote_report_bindings WHERE thread_id = ${threadId}
  `.pipe(Effect.mapError(storage), Effect.flatMap(decodeRows), Effect.mapError(storage));
  const bindingForCorrelation = (correlationId: string) =>
    sql`
    SELECT thread_id AS "threadId", correlation_id AS "correlationId",
      origin_label AS "originLabel", origin_thread_id AS "originThreadId",
      read_key_hash AS "readKeyHash", relay_send AS "relaySend", last_sequence AS "lastSequence"
    FROM remote_report_bindings WHERE correlation_id = ${correlationId}
  `.pipe(Effect.mapError(storage), Effect.flatMap(decodeRows), Effect.mapError(storage));
  const bind = Effect.fn("RemoteReportService.bind")(function* (
    threadId: ThreadId,
    input: RemoteReportBindingInput,
  ) {
    const value = yield* decodeBindingInput(input).pipe(Effect.mapError(invalid));
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    // The fence check and the insert share one write transaction, so a late bind and a
    // reconcile's resolve-or-fence can never both land for the same correlation id.
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const fenced = yield* sql`
            SELECT correlation_id FROM remote_report_fences WHERE correlation_id = ${value.correlationId}
          `;
          if (fenced.length > 0) return yield* new RemoteReportError({ reason: "fenced" });
          yield* sql`
            INSERT INTO remote_report_bindings
              (thread_id, correlation_id, origin_label, origin_thread_id, read_key_hash, relay_send, created_at)
            VALUES (${threadId}, ${value.correlationId}, ${value.originLabel}, ${value.originThreadId}, ${value.readKeyHash}, ${relaySendLevel(value)}, ${createdAt})
          `;
        }),
      )
      .pipe(Effect.mapError(storageUnlessReport));
  });
  const unbind = Effect.fn("RemoteReportService.unbind")(function* (threadId: ThreadId) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM remote_reports WHERE correlation_id IN
        (SELECT correlation_id FROM remote_report_bindings WHERE thread_id = ${threadId})`;
          yield* sql`DELETE FROM remote_relay_requests WHERE correlation_id IN
        (SELECT correlation_id FROM remote_report_bindings WHERE thread_id = ${threadId})`;
          yield* sql`DELETE FROM remote_report_bindings WHERE thread_id = ${threadId}`;
        }),
      )
      .pipe(Effect.mapError(storage));
    yield* PubSub.publish(signals, undefined);
  });
  // Read once per report: the run active now is the run that made it, even if a restart
  // replaces it before the report is stored.
  const liveShell = Effect.fn("RemoteReportService.liveShell")(function* (threadId: ThreadId) {
    const shell = yield* orchestrator.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
    if (shell === null || shell.deletedAt !== null)
      return yield* new RemoteReportError({ reason: "thread_deleted" });
    return shell;
  });
  type LiveShell = Effect.Success<ReturnType<typeof liveShell>>;
  const append = Effect.fn("RemoteReportService.append")(function* (
    threadId: ThreadId,
    shell: LiveShell,
    agentReport: RemoteOriginReportInput,
    agentRelay: RemoteRelaySend | null,
  ) {
    // An agent's report is stored and relayed like its tool output.
    const value = redactGoatCredentialsDeep(agentReport);
    const relay = redactGoatCredentialsDeep(agentRelay);
    const runId = shell.activeRunId;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const binding = (yield* bindingForThread(threadId))[0];
          if (binding === undefined) return yield* new RemoteReportError({ reason: "not_bound" });
          if (
            relay !== null &&
            (binding.relaySend === 0 ||
              ((relay.capabilities?.length ?? 0) > 0 &&
                binding.relaySend !== RELAY_WITH_CAPABILITIES))
          )
            return yield* new RemoteReportError({ reason: "relay_unsupported" });
          // A retried relay is the same request, even after the origin collected it.
          if (relay?.clientRequestId !== undefined) {
            const earlier = yield* sql<{
              sequence: number;
            }>`SELECT sequence FROM remote_relay_requests
              WHERE correlation_id = ${binding.correlationId}
              AND client_request_id = ${relay.clientRequestId}`;
            if (earlier[0] !== undefined) return { sequence: earlier[0].sequence };
          }
          if (relay !== null) {
            const pending = yield* sql<{
              count: number;
            }>`SELECT COUNT(*) AS count FROM remote_reports
              WHERE correlation_id = ${binding.correlationId} AND relay IS NOT NULL`;
            if ((pending[0]?.count ?? 0) >= MAX_PENDING_RELAYS)
              return yield* new RemoteReportError({ reason: "relay_queue_full" });
          }
          const sequence = binding.lastSequence + 1;
          yield* sql`UPDATE remote_report_bindings SET last_sequence = ${sequence} WHERE thread_id = ${threadId}`;
          yield* sql`
        INSERT INTO remote_reports (correlation_id, sequence, run_id, kind, summary, relay, created_at)
        VALUES (${binding.correlationId}, ${sequence}, ${runId}, ${value.status}, ${value.summary}, ${relay === null ? null : encodeRelay(relay)}, ${createdAt})
      `;
          if (relay?.clientRequestId !== undefined)
            yield* sql`INSERT INTO remote_relay_requests (correlation_id, client_request_id, sequence)
              VALUES (${binding.correlationId}, ${relay.clientRequestId}, ${sequence})`;
          // Keep the newest 200 reports, preferring substantive ones over progress. A relay
          // stays until the origin collects it, because a pruned one would never be sent.
          yield* sql`
        DELETE FROM remote_reports WHERE correlation_id = ${binding.correlationId}
          AND sequence IN (
            SELECT sequence FROM remote_reports
            WHERE correlation_id = ${binding.correlationId} AND relay IS NULL
            ORDER BY CASE WHEN kind = 'progress' THEN 1 ELSE 0 END, sequence DESC
            LIMIT -1 OFFSET 200
          )
      `;
          return { sequence };
        }),
      )
      .pipe(Effect.mapError((cause) => (isRemoteReportError(cause) ? cause : storage(cause))));
    yield* PubSub.publish(signals, undefined);
    return result;
  });
  const report = Effect.fn("RemoteReportService.report")(function* (
    threadId: ThreadId,
    input: RemoteOriginReportInput,
  ) {
    // Remote or local, an agent's report is stored and relayed like its tool output.
    const value = redactGoatCredentialsDeep(
      yield* decodeReportInput(input).pipe(Effect.mapError(invalid)),
    );
    const shell = yield* liveShell(threadId);
    return yield* append(threadId, shell, value, null).pipe(
      Effect.catchIf(
        (error) => error.reason === "not_bound",
        () => reportToLauncher(threadId, shell, value),
      ),
    );
  });
  /**
   * A thread launched by a thread on this machine has no origin binding: its origin is that
   * launcher, found the way question escalation finds it. A question wakes the launcher; any
   * other report waits in its inbox for its next turn, as an origin's `wake` delivery does.
   */
  const reportToLauncher = Effect.fn("RemoteReportService.reportToLauncher")(function* (
    threadId: ThreadId,
    shell: LiveShell,
    value: RemoteOriginReportInput,
  ) {
    const parentId = shell.lineage.parentThreadId;
    const subagents =
      shell.launchedBy === undefined &&
      parentId !== null &&
      shell.lineage.relationshipToParent === "subagent"
        ? (yield* orchestrator
            .getThreadRecords(parentId, ["subagents"])
            .pipe(Effect.mapError(unavailable))).subagents
        : [];
    const launcherId = localQuestionLauncher(shell, subagents);
    if (launcherId === undefined) return yield* new RemoteReportError({ reason: "not_bound" });
    const text = frameRemoteReport({
      host: "this machine",
      correlationId: threadId,
      kind: value.status,
      summary: value.summary,
      source: "agent",
      standalone: value.status === "needs_input",
    });
    if (value.status === "needs_input") {
      const key = `origin-report:${threadId}:${NodeCrypto.randomUUID()}`;
      yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:${key}`),
          threadId: launcherId,
          messageId: MessageId.make(`message:${key}`),
          text: `${text}\nRead the thread with goat_call {path: "thread.read", args: {threadId: "${threadId}"}} and answer it with goat_call {path: "thread.send"}.`,
          attachments: [],
          createdBy: "agent",
          creationSource: "server",
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: `${shell.title.slice(0, 80)}: needs_input`,
          },
          dispatchMode: { type: "queue_after_active" },
        })
        .pipe(Effect.mapError(unavailable));
    } else {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`INSERT INTO remote_report_inbox
        (origin_thread_id, correlation_id, kind, text, run_id, created_at)
        VALUES (${launcherId}, ${`local:${threadId}`}, ${value.status}, ${text},
          ${shell.activeRunId}, ${createdAt})`.pipe(Effect.mapError(storage));
    }
    return { sequence: 0, delivery: "launcher" as const };
  });
  const relay = Effect.fn("RemoteReportService.relay")(function* (
    threadId: ThreadId,
    input: RemoteRelaySend,
  ) {
    const value = yield* decodeRelayInput(input).pipe(Effect.mapError(invalid));
    return yield* append(
      threadId,
      yield* liveShell(threadId),
      {
        status: "progress",
        summary: `Asked to relay goat_thread_send to thread ${value.threadId} on ${value.host}.`,
      },
      value,
    );
  });
  const wait = Effect.fn("RemoteReportService.wait")(function* (
    input: RemoteOriginReportsWaitInput,
  ) {
    const value = yield* decodeWaitInput(input).pipe(Effect.mapError(invalid));
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(signals);
        const authorize = Effect.gen(function* () {
          const binding = (yield* bindingForCorrelation(value.correlationId))[0];
          const supplied = NodeCrypto.createHash("sha256").update(value.readKey, "utf8").digest();
          // Compare equal-size buffers even when the correlation does not exist.
          const expected = Buffer.from(binding?.readKeyHash ?? "0".repeat(64), "hex");
          const matches = NodeCrypto.timingSafeEqual(supplied, expected);
          if (binding === undefined || !matches)
            return yield* new RemoteReportError({ reason: "access_denied" });
          if (value.afterSequence > binding.lastSequence)
            return yield* new RemoteReportError({ reason: "invalid_request" });
          return binding;
        });
        const binding = yield* authorize;
        const afterSequence = yield* orchestrator
          .getThreadEventSequence(binding.threadId)
          .pipe(Effect.mapError(unavailable));
        // Local subagent threads seen on the read that opened this wait, so a request that
        // arrives while we wait still wakes it. Captured with afterSequence, before that read.
        let watchedChildThreadIds: ReadonlyArray<ThreadId> = [];
        // A live run's open questions; what still holds a finished run's thread open; and what
        // the thread shows besides its run status, read as the origin reads a local worker.
        const runState = (
          run: OrchestrationV2Run,
          shell: OrchestrationV2ThreadShell,
          result: ThreadResult | null,
        ) =>
          Effect.gen(function* () {
            const requests = yield* orchestrator
              .getThreadRecords(binding.threadId, ["runtimeRequests", "subagents"])
              .pipe(Effect.mapError(unavailable));
            const pullRequests = pullRequestsFromLinks(shell.pullRequests);
            // A subagent on this machine waiting on a person blocks the work as much as the
            // worker. The approval names that thread, which is a thread on this machine.
            const children = yield* scanSubagents(requests.subagents, (threadId) =>
              orchestrator.getThreadRecords(threadId, ["runtimeRequests", "subagents"]),
            );
            watchedChildThreadIds = children.localThreadIds;
            const needsYou = needsYouFromRuntimeRequests(
              [
                ...requests.runtimeRequests.map((request) => ({
                  ...request,
                  threadId: binding.threadId,
                })),
                ...children.requests,
              ],
              (request) => request.threadId,
            );
            if (!isTerminalRunStatus(run.status)) {
              const items = yield* orchestrator
                .getThreadRecords(binding.threadId, ["turnItems"], {
                  turnItemTypes: ["user_input_request"],
                  turnItemRunIds: [run.id],
                })
                .pipe(Effect.mapError(unavailable));
              const requestIds = items.turnItems.flatMap((item) =>
                item.type === "user_input_request" && item.runId === run.id ? [item.requestId] : [],
              );
              const requested = new Set<string>(requestIds);
              return {
                pendingRequestIds:
                  requestIds.length === 0
                    ? []
                    : pendingUserInputRequestIdsForRun(
                        {
                          ...items,
                          runtimeRequests: requests.runtimeRequests.filter((request) =>
                            requested.has(request.id),
                          ),
                        },
                        run.id,
                      ),
                observation: observeWorker({ pullRequests, needsYou, result }),
              };
            }
            const records = yield* orchestrator
              .getThreadRecords(binding.threadId, ["providerThreads"])
              .pipe(Effect.mapError(unavailable));
            const continuationPending = yield* orchestrator
              .delegatedTaskResultPending(binding.threadId)
              .pipe(Effect.mapError(unavailable));
            // This machine cannot arm recovery for the origin, so a limit nothing resumes needs a person.
            const limit =
              run.status === "failed" ? usageLimitWait(shell, run, yield* DateTime.now) : undefined;
            return {
              holds: {
                backgroundTasks: completionHoldCount({
                  current: run,
                  runs: [run],
                  providerThreads: records.providerThreads,
                  pullRequests: shell.pullRequests,
                }),
                continuationPending,
              },
              observation: observeWorker({
                result,
                pullRequests,
                needsYou: [...needsYou, ...(limit?.needsYou === undefined ? [] : [limit.needsYou])],
                usageLimitResetAt: limit?.resetAt,
              }),
            };
          });
        const read = Effect.gen(function* () {
          const reports = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* authorize;
                yield* sql`DELETE FROM remote_reports WHERE correlation_id = ${value.correlationId} AND sequence <= ${value.afterSequence}`;
                const rows = yield* sql`
            SELECT sequence, run_id AS "runId", kind, summary, relay, created_at AS "createdAt"
            FROM remote_reports WHERE correlation_id = ${value.correlationId} AND sequence > ${value.afterSequence}
            ORDER BY sequence LIMIT 51
          `;
                return yield* decodeReports(rows);
              }),
            )
            .pipe(
              Effect.mapError((cause) => (isRemoteReportError(cause) ? cause : storage(cause))),
            );
          const shell = yield* orchestrator
            .getThreadShell(binding.threadId)
            .pipe(Effect.mapError(unavailable));
          if (shell === null || shell.deletedAt !== null)
            return yield* new RemoteReportError({ reason: "thread_deleted" });
          const runId = value.watchRunId ?? shell.latestRunId;
          let observedRun: RemoteOriginReportsWaitResult["observedRun"] = null;
          if (runId !== null) {
            const records = yield* orchestrator
              .getThreadRecords(binding.threadId, ["runs"], { runIds: [runId] })
              .pipe(Effect.mapError(unavailable));
            const run = records.runs.find((candidate) => candidate.id === runId);
            if (run === undefined) return yield* new RemoteReportError({ reason: "run_not_found" });
            const result = yield* readThreadResult(shell, run).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.catch((cause) =>
                isTerminalRunStatus(run.status)
                  ? Effect.fail(unavailable(cause))
                  : Effect.succeed(null),
              ),
            );
            let summary: string | null = null;
            let reported: RemoteReportedOutcome | undefined;
            if (isTerminalRunStatus(run.status)) {
              const messages = yield* orchestrator
                .getThreadRecords(binding.threadId, ["messages"], {
                  messageRoles: ["assistant"],
                  messageRunIds: [runId],
                })
                .pipe(Effect.mapError(unavailable));
              summary =
                messages.messages
                  .filter((message) => message.runId === runId && message.role === "assistant")
                  .toSorted(
                    (a, b) =>
                      DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
                      a.id.localeCompare(b.id),
                  )
                  .at(-1)
                  ?.text.slice(0, REMOTE_REPORT_SUMMARY_MAX_CHARS) ?? null;
              // The origin settles a completed run from the worker's own report.
              if (result !== null && result.reportedAt !== null && result.outcome !== null) {
                const reportedSummary = result.summary?.trim();
                reported = {
                  outcome: result.outcome,
                  ...(reportedSummary === undefined || reportedSummary === ""
                    ? {}
                    : { summary: reportedSummary.slice(0, REMOTE_REPORT_SUMMARY_MAX_CHARS) }),
                };
              }
            }
            observedRun = {
              runId,
              status: run.status,
              summary,
              ...(yield* runState(run, shell, result)),
              ...(reported === undefined ? {} : { reported }),
            };
          }
          return {
            threadId: binding.threadId,
            reports: reports.slice(0, 50),
            hasMore: reports.length > 50,
            observedRun,
            latestRunId: shell.latestRunId,
            timedOut: false,
          } satisfies RemoteOriginReportsWaitResult;
        });
        const changed = (result: RemoteOriginReportsWaitResult) =>
          result.reports.length > 0 || observedRunChanged(value.knownRun, result.observedRun);
        const first = yield* read;
        if (changed(first)) return first;
        if (value.timeoutMs === 0) return { ...first, timedOut: true };
        const childThreadIds = new Set<string>(watchedChildThreadIds);
        const stream = (eventType: OrchestrationV2DomainEvent["type"]) =>
          orchestrator.streamStoredEventsFrom({
            threadId: binding.threadId,
            afterSequence,
            eventType,
          });
        const events = Stream.mergeAll(
          [
            stream("run.updated").pipe(
              Stream.filter(
                (stored) =>
                  value.watchRunId === null ||
                  (stored.event.type === "run.updated" &&
                    stored.event.payload.id === value.watchRunId),
              ),
            ),
            stream("thread.deleted"),
            // Following the latest run means a newly created run is a change too.
            value.watchRunId === null ? stream("run.created") : Stream.empty,
            // Questions open and close; background work starts and ends.
            stream("runtime-request.updated"),
            // The question item can commit after its request; other items need no read.
            stream("turn-item.updated").pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "turn-item.updated" &&
                  stored.event.payload.type === "user_input_request",
              ),
            ),
            stream("provider-thread.updated"),
            // Pull request links, watches and usage-limit recovery choices change the observation.
            stream("thread.pull-request-link-updated"),
            stream("thread.pull-request-synced"),
            stream("thread.metadata-updated"),
            // One global stream, filtered, so a live local subagent's approval wakes this wait
            // without a subscription per child. Empty when this worker has no such thread.
            ...(childThreadIds.size === 0
              ? []
              : [
                  orchestrator
                    .streamStoredEventsFrom({
                      afterSequence,
                      eventType: "runtime-request.updated",
                    })
                    .pipe(Stream.filter((stored) => childThreadIds.has(stored.event.threadId))),
                ]),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Stream.mapError(unavailable),
          Stream.map(() => undefined),
        );
        const waited = yield* Stream.merge(Stream.fromSubscription(subscription), events).pipe(
          Stream.mapEffect(() => read),
          Stream.filter(changed),
          Stream.runHead,
          Effect.timeoutOption(value.timeoutMs),
        );
        const result = Option.flatten(waited);
        if (Option.isSome(result)) return result.value;
        const final = yield* read;
        return { ...final, timedOut: !changed(final) };
      }),
    );
  });
  const origin = Effect.fn("RemoteReportService.origin")(function* (threadId: ThreadId) {
    const binding = (yield* bindingForThread(threadId))[0];
    return binding === undefined
      ? null
      : {
          originLabel: binding.originLabel,
          originThreadId: binding.originThreadId,
          relaySend: binding.relaySend !== 0,
        };
  });
  const relayReceipt = Effect.fn("RemoteReportService.relayReceipt")(function* (
    threadId: ThreadId,
    clientRequestId: string,
  ) {
    const rows = yield* sql<{ sequence: number; originLabel: string }>`
      SELECT request.sequence, binding.origin_label AS "originLabel"
      FROM remote_report_bindings AS binding
      JOIN remote_relay_requests AS request ON request.correlation_id = binding.correlation_id
      WHERE binding.thread_id = ${threadId} AND request.client_request_id = ${clientRequestId}
    `.pipe(Effect.mapError(storage));
    return rows[0] ?? null;
  });
  const resolveBinding = Effect.fn("RemoteReportService.resolveBinding")(function* (
    input: RemoteResolveBindingInput,
  ) {
    const value = yield* decodeResolveInput(input).pipe(Effect.mapError(invalid));
    const supplied = NodeCrypto.createHash("sha256").update(value.readKey, "utf8").digest();
    const suppliedHex = supplied.toString("hex");
    const authorized = (storedHash: string) =>
      NodeCrypto.timingSafeEqual(supplied, Buffer.from(storedHash, "hex"));
    const binding = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const found = (yield* bindingForCorrelation(value.correlationId))[0];
          if (found !== undefined) {
            if (!authorized(found.readKeyHash))
              return yield* new RemoteReportError({ reason: "access_denied" });
            return found;
          }
          const fences = yield* sql<{ readonly readKeyHash: string }>`
            SELECT read_key_hash AS "readKeyHash" FROM remote_report_fences
            WHERE correlation_id = ${value.correlationId}
          `;
          const fence = fences[0];
          if (fence !== undefined) {
            if (!authorized(fence.readKeyHash))
              return yield* new RemoteReportError({ reason: "access_denied" });
            return null;
          }
          // Absent is not proof: a launch in flight binds after this lookup. The fence makes
          // the absence durable, and its confirmation is what the origin may release on.
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO remote_report_fences (correlation_id, read_key_hash, created_at)
            VALUES (${value.correlationId}, ${suppliedHex}, ${createdAt})
          `;
          return null;
        }),
      )
      .pipe(Effect.mapError(storageUnlessReport));
    if (binding === null) return { _tag: "fenced" as const };
    // The shell read stays outside the transaction: a thread created right after the commit
    // is still found, and a missing one only means the destination has not started it yet.
    const shell = yield* orchestrator
      .getThreadShell(binding.threadId)
      .pipe(Effect.mapError(unavailable));
    return {
      _tag: "bound" as const,
      threadId: binding.threadId,
      originThreadId: binding.originThreadId,
      threadExists: shell !== null,
      threadDeleted: shell?.deletedAt != null,
      activeRunId: shell?.activeRunId ?? null,
    };
  });
  return RemoteReportService.of({
    bind,
    unbind,
    origin,
    report,
    relay,
    relayReceipt,
    wait,
    resolveBinding,
  });
});
export const layer = Layer.effect(RemoteReportService, make);
