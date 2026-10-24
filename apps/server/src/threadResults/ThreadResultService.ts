import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
  type ThreadResult,
  type ThreadResultObservedCheck,
  type ThreadResultPullRequest,
  ThreadResultReport,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { redactGoatCredentialsDeep } from "../mcp/goatCredentialRedaction.ts";
import { readObservedCheck, readObservedCheckState } from "./ObservedCheckService.ts";

export class ThreadResultError extends Schema.TaggedError<ThreadResultError>()(
  "ThreadResultError",
  {
    reason: Schema.Literals(["run_not_found", "storage"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "run_not_found"
      ? "The thread has no run to report on."
      : "Thread result storage failed.";
  }
}

export interface StoredThreadResultReport {
  readonly report: ThreadResultReport;
  readonly reportedAt: string;
}

/**
 * The structured result of one run. The agent's report wins where it says
 * something; GOAT's own facts fill the rest. Pure, so the read tools and a
 * completion notification produce the same value.
 */
export function buildThreadResult(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "branch" | "pullRequests" | "linkedPullRequest">;
  readonly run: Pick<OrchestrationV2Run, "id" | "status">;
  readonly stored: StoredThreadResultReport | null;
  readonly observedCheck?: ThreadResultObservedCheck | null;
}): ThreadResult {
  const report = input.stored?.report;
  const pullRequests: Array<ThreadResultPullRequest> = [];
  const seen = new Set<string>();
  const add = (pullRequest: ThreadResultPullRequest) => {
    if (seen.has(pullRequest.url)) return;
    seen.add(pullRequest.url);
    pullRequests.push(pullRequest);
  };
  for (const pullRequest of report?.pullRequests ?? []) add(pullRequest);
  const links = input.thread.pullRequests ?? [];
  for (const link of links) {
    if (link.source === "stack-dismissed") continue;
    add({
      url: link.url,
      number: link.number,
      ...(link.snapshot === null ? {} : { state: link.snapshot.state }),
    });
  }
  // Threads from before the pull request list carry only the single link.
  if (links.length === 0 && input.thread.linkedPullRequest) {
    add({ url: input.thread.linkedPullRequest.url, number: input.thread.linkedPullRequest.number });
  }
  const derivedOutcome =
    input.run.status === "failed"
      ? ("failed" as const)
      : input.run.status === "interrupted" || input.run.status === "cancelled"
        ? ("cancelled" as const)
        : null;
  return {
    runId: input.run.id,
    runStatus: input.run.status,
    outcome: report?.outcome ?? derivedOutcome,
    reportedAt: input.stored?.reportedAt ?? null,
    ...(report?.summary === undefined ? {} : { summary: report.summary }),
    pullRequests,
    ...(report?.tests === undefined ? {} : { tests: report.tests }),
    ...(input.observedCheck == null ? {} : { observedCheck: input.observedCheck }),
    commits: report?.commits ?? [],
    branch: report?.branch ?? input.thread.branch,
  };
}

/**
 * Structured results of thread runs. Agents report through
 * goat_thread_report_result; orchestrators read the merged result from
 * goat_thread_read and goat_thread_wait instead of parsing chat text.
 */
export class ThreadResultService extends Context.Service<
  ThreadResultService,
  {
    /** Record a report for the thread's live run, or its latest run when none is live. */
    readonly report: (
      threadId: ThreadId,
      report: ThreadResultReport,
    ) => Effect.Effect<ThreadResult, ThreadResultError>;
    readonly subscribeReports: Effect.Effect<Stream.Stream<ThreadId>, never, Scope.Scope>;
    /** One run's result; the latest run when runId is omitted, null when there is none. */
    readonly forRun: (
      threadId: ThreadId,
      runId?: RunId | null,
    ) => Effect.Effect<ThreadResult | null, ThreadResultError>;
  }
>()("goat/threadResults/ThreadResultService") {}

const ReportRow = Schema.Struct({
  reportJson: Schema.fromJsonString(ThreadResultReport),
  reportedAt: Schema.String,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ReportRow));
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(ThreadResultReport));

/** The agent's report is independent of any check the host runs. */
const readStoredThreadResultReport = (threadId: ThreadId, runId: RunId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      SELECT report_json AS "reportJson", reported_at AS "reportedAt"
      FROM thread_run_results WHERE thread_id = ${threadId} AND run_id = ${runId}
    `.pipe(Effect.flatMap(decodeRows));
    const row = rows[0];
    return row === undefined
      ? null
      : ({ report: row.reportJson, reportedAt: row.reportedAt } satisfies StoredThreadResultReport);
  }).pipe(Effect.mapError((cause) => new ThreadResultError({ reason: "storage", cause })));

/** Reuses an already-read projection when observing local or remote channel workers. */
export const readThreadResult = Effect.fn("ThreadResultService.readThreadResult")(function* (
  thread: Pick<OrchestrationV2AppThread, "id" | "branch" | "pullRequests" | "linkedPullRequest">,
  run: Pick<OrchestrationV2Run, "id" | "status">,
) {
  const checkState = yield* readObservedCheckState(thread.id, run.id).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("thread check evidence unreadable", {
        threadId: thread.id,
        runId: run.id,
        cause,
      }).pipe(Effect.as({ check: null, pending: true })),
    ),
  );
  return {
    ...buildThreadResult({
      thread,
      run,
      stored: yield* readStoredThreadResultReport(thread.id, run.id),
      observedCheck: checkState.check,
    }),
    observedCheckPending: run.status === "completed" && checkState.pending,
  };
});

const make = Effect.gen(function* () {
  const reports = yield* PubSub.unbounded<ThreadId>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(reports));
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const storage = (cause: unknown) => new ThreadResultError({ reason: "storage", cause });

  const load = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, ["runs"]).pipe(Effect.mapError(storage));

  const observedCheck = (threadId: ThreadId, runId: RunId) =>
    readObservedCheck(threadId, runId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(storage),
    );

  const forRun = Effect.fn("ThreadResultService.forRun")(function* (
    threadId: ThreadId,
    runId?: RunId | null,
  ) {
    const records = yield* load(threadId);
    const run =
      runId === undefined || runId === null
        ? ThreadManagementService.latestRun(records)
        : records.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) return null;
    return yield* readThreadResult(records.thread, run).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  });

  const report = Effect.fn("ThreadResultService.report")(function* (
    threadId: ThreadId,
    agentReport: ThreadResultReport,
  ) {
    // An agent's report is stored and relayed like its tool output.
    const input = redactGoatCredentialsDeep(agentReport);
    const records = yield* load(threadId);
    const run =
      ThreadManagementService.latestActiveRun(records) ??
      ThreadManagementService.latestRun(records);
    if (run === undefined) return yield* new ThreadResultError({ reason: "run_not_found" });
    const reportedAt = DateTime.formatIso(yield* DateTime.now);
    const reportJson = yield* encodeReport(input).pipe(Effect.mapError(storage));
    yield* sql`
      INSERT INTO thread_run_results (thread_id, run_id, report_json, reported_at)
      VALUES (${threadId}, ${run.id}, ${reportJson}, ${reportedAt})
      ON CONFLICT (thread_id, run_id) DO UPDATE SET
        report_json = excluded.report_json,
        reported_at = excluded.reported_at
    `.pipe(Effect.mapError(storage));
    yield* PubSub.publish(reports, threadId);
    return buildThreadResult({
      thread: records.thread,
      run,
      stored: { report: input, reportedAt },
      observedCheck: yield* observedCheck(threadId, run.id),
    });
  });

  return ThreadResultService.of({
    report,
    forRun,
    subscribeReports: PubSub.subscribe(reports).pipe(Effect.map(Stream.fromSubscription)),
  });
});

export const layer = Layer.effect(ThreadResultService, make);
