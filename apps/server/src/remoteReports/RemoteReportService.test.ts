// @effect-diagnostics nodeBuiltinImport:off - the origin side hashes its read key with node:crypto.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import {
  ThreadId,
  RunId,
  RuntimeRequestId,
  MessageId,
  type OrchestrationV2Run,
  type ThreadPullRequestLink,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  type ThreadResultReport,
} from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import migration from "../persistence/Migrations/069_RemoteReports.ts";
import dispatchMigration from "../persistence/Migrations/070_RemoteDispatches.ts";
import threadRunResultsMigration from "../persistence/Migrations/073_ThreadRunResults.ts";
import relayMigration from "../persistence/Migrations/074_RemoteReportRelay.ts";
import observedChecksMigration from "../persistence/Migrations/091_ThreadRunObservedChecks.ts";
import * as RemoteReportService from "./RemoteReportService.ts";

const threadId = ThreadId.make("remote-thread");
const runA = RunId.make("run-a");
const runB = RunId.make("run-b");
const readKey = "1".repeat(64);
const binding = {
  correlationId: "correlation",
  originLabel: "origin laptop",
  originThreadId: ThreadId.make("origin-thread"),
  readKeyHash: NodeCrypto.createHash("sha256").update(readKey, "utf8").digest("hex"),
};
const waitInput = {
  correlationId: binding.correlationId,
  readKey,
  afterSequence: 0,
  watchRunId: runA,
  knownRun: { runId: runA, status: "running" },
  timeoutMs: 10000,
};
const run = (id: RunId, status: OrchestrationV2Run["status"], ordinal = 1) =>
  ({ id, threadId, status, ordinal }) as OrchestrationV2Run;
const message = (
  id: string,
  runId: RunId,
  text: string,
  role: "assistant" | "user" = "assistant",
) =>
  ({
    id: MessageId.make(id),
    threadId,
    runId,
    text,
    role,
    createdAt: DateTime.makeUnsafe(0),
  }) as OrchestrationV2ConversationMessage;
const stored = (sequence: number, event: object) =>
  ({
    sequence,
    commandId: null,
    event: { threadId, ...event },
  }) as unknown as OrchestrationV2StoredEvent;
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* migration;
  yield* dispatchMigration;
  yield* threadRunResultsMigration;
  yield* observedChecksMigration;
  yield* relayMigration;
  const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const changeTypes = [
    "thread.deleted",
    "runtime-request.updated",
    "turn-item.updated",
    "provider-thread.updated",
    "thread.pull-request-link-updated",
    "thread.pull-request-synced",
    "thread.metadata-updated",
  ] as const;
  const changeQueues = new Map(
    yield* Effect.forEach(changeTypes, (type) =>
      Queue.unbounded<OrchestrationV2StoredEvent>().pipe(
        Effect.map((queue) => [type, queue] as const),
      ),
    ),
  );
  const changes = (event: OrchestrationV2StoredEvent) => {
    const queue = changeQueues.get(event.event.type as (typeof changeTypes)[number]);
    return queue === undefined
      ? Effect.die("unexpected fixture event " + event.event.type)
      : Queue.offer(queue, event);
  };
  const creations = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const subscribed = yield* Deferred.make<void, RemoteReportService.RemoteReportError>();
  const state: {
    runs: OrchestrationV2Run[];
    messages: OrchestrationV2ConversationMessage[];
    activeRunId: RunId | null;
    latestRunId: RunId | null;
    deletedAt: string | null;
    reads: number;
    afterRead: Effect.Effect<void> | undefined;
    /** Open question ids on runA; the fake joins items and requests as the projection does. */
    questions: string[];
    backgroundTasks: number;
    continuationPending: boolean;
    subagents: ReadonlyArray<OrchestrationV2Subagent> | undefined;
    shell: Partial<OrchestrationV2ThreadShell>;
    subscriptions: Array<
      Parameters<Orchestrator.OrchestratorV2["Service"]["streamStoredEventsFrom"]>[0]
    >;
  } = {
    runs: [run(runA, "running")],
    messages: [],
    activeRunId: runA,
    latestRunId: runA,
    deletedAt: null,
    reads: 0,
    afterRead: undefined,
    questions: [],
    backgroundTasks: 0,
    continuationPending: false,
    subagents: [],
    shell: { pullRequests: [] },
    subscriptions: [],
  };
  const fake = Layer.mock(Orchestrator.OrchestratorV2)({
    getThreadShell: () =>
      Effect.sync(
        () =>
          ({
            id: threadId,
            activeRunId: state.activeRunId,
            latestRunId: state.latestRunId,
            deletedAt: state.deletedAt,
            ...state.shell,
          }) as unknown as OrchestrationV2ThreadShell,
      ),
    getThreadEventSequence: () => Effect.succeed(17),
    getThreadRecords: (_threadId, fields) =>
      Effect.gen(function* () {
        // Counts run and transcript reads; question and hold lookups ride along.
        if (fields.some((field) => field === "runs" || field === "messages")) state.reads += 1;
        const result = {
          thread: { id: threadId, deletedAt: state.deletedAt },
          runs: state.runs.map((item) => ({ ...item })),
          messages: [...state.messages],
          turnItems: state.questions.map((requestId) => ({
            type: "user_input_request",
            runId: runA,
            requestId,
          })),
          runtimeRequests: state.questions.map((id) => ({
            id,
            kind: "user_input",
            status: "pending",
            createdAt: DateTime.makeUnsafe(0),
          })),
          providerThreads: [
            {
              pendingBackgroundTasks: Array.from({ length: state.backgroundTasks }, (_, i) => ({
                taskId: `background-${i}`,
              })),
            },
          ],
          subagents: state.subagents,
        };
        const after = state.afterRead;
        state.afterRead = undefined;
        if (after !== undefined) yield* after;
        return result as unknown as OrchestrationV2ThreadProjection;
      }),
    delegatedTaskResultPending: () => Effect.sync(() => state.continuationPending),
    streamStoredEventsFrom: (input) => {
      state.subscriptions.push(input);
      return input?.eventType === "run.updated"
        ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromQueue(events)),
          )
        : input?.eventType === "run.created"
          ? Stream.fromQueue(creations)
          : Stream.fromQueue(changeQueues.get(input!.eventType as (typeof changeTypes)[number])!);
    },
  });
  const context = yield* Layer.build(RemoteReportService.layer.pipe(Layer.provide(fake)));
  const rawService = Context.get(context, RemoteReportService.RemoteReportService);
  // wait reads once before opening event streams, so a failure there must fail subscribed too.
  const service: RemoteReportService.RemoteReportService["Service"] = {
    ...rawService,
    wait: (input) =>
      rawService.wait(input).pipe(Effect.onError((cause) => Deferred.failCause(subscribed, cause))),
  };
  yield* service.bind(threadId, binding);
  const lifetime = yield* Effect.scope;
  const recreate = Layer.buildWithScope(
    RemoteReportService.layer.pipe(Layer.provide(fake)),
    lifetime,
  ).pipe(
    Effect.map((context) => Context.get(context, RemoteReportService.RemoteReportService)),
    Effect.provideService(SqlClient.SqlClient, sql),
  );
  return { service, sql, state, events, changes, creations, subscribed, recreate };
});
type Fixture = Effect.Success<typeof setup>;
const withFixture = <A, E, R>(body: (fixture: Fixture) => Effect.Effect<A, E, R>) =>
  setup.pipe(
    Effect.flatMap(body),
    Effect.scoped,
    Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
const test = <E>(name: string, body: (fixture: Fixture) => Effect.Effect<void, E>) =>
  it.effect(name, () => withFixture(body));
test("stores a relay only for a binding whose origin declared it", ({ service }) =>
  Effect.gen(function* () {
    const send = { host: "sibling", threadId: ThreadId.make("target"), message: "hello" };
    expect((yield* service.origin(threadId))?.relaySend).toBe(false);
    expect((yield* service.relay(threadId, send).pipe(Effect.flip)).reason).toBe(
      "relay_unsupported",
    );
    const relaying = ThreadId.make("relaying-thread");
    yield* service.bind(relaying, { ...binding, correlationId: "relaying", relaySend: true });
    expect((yield* service.origin(relaying))?.relaySend).toBe(true);
    expect(yield* service.relay(relaying, send)).toEqual({ sequence: 1 });
    // A retry before the origin collects it is the same request.
    const retried = { ...send, clientRequestId: "pr-48" };
    expect(yield* service.relay(relaying, retried)).toEqual({ sequence: 2 });
    expect(yield* service.relay(relaying, retried)).toEqual({ sequence: 2 });
    const read = yield* service.wait({ ...waitInput, correlationId: "relaying" });
    expect(read.reports.map((entry) => entry.relay)).toEqual([send, retried]);
    const plain = yield* service.report(relaying, { status: "progress", summary: "working" });
    const next = yield* service.wait({ ...waitInput, correlationId: "relaying", afterSequence: 2 });
    expect(next.reports.map((entry) => [entry.sequence, entry.relay])).toEqual([
      [plain.sequence, undefined],
    ]);
    // Still the same request after the origin collected and acknowledged it.
    expect(yield* service.relay(relaying, retried)).toEqual({ sequence: 2 });
  }));
test("keeps uncollected relays through report retention and caps how many wait", ({ service }) =>
  Effect.gen(function* () {
    const relaying = ThreadId.make("relaying-thread");
    yield* service.bind(relaying, { ...binding, correlationId: "relaying", relaySend: true });
    const send = { host: "sibling", threadId: ThreadId.make("target"), message: "hello" };
    yield* service.relay(relaying, send);
    for (let i = 0; i < 205; i++)
      yield* service.report(relaying, { status: "needs_input", summary: String(i) });
    const kept = yield* service.wait({ ...waitInput, correlationId: "relaying", timeoutMs: 0 });
    expect(kept.reports[0]).toMatchObject({ sequence: 1, relay: send });
    for (let i = 1; i < RemoteReportService.MAX_PENDING_RELAYS; i++)
      yield* service.relay(relaying, send);
    expect((yield* service.relay(relaying, send).pipe(Effect.flip)).reason).toBe(
      "relay_queue_full",
    );
  }));
test("refuses binding replacement and validates domain input", ({ service }) =>
  Effect.gen(function* () {
    const invalidWait = yield* service
      .wait({ ...waitInput, readKey: "invalid", timeoutMs: 600001 })
      .pipe(Effect.flip);
    expect(invalidWait.reason).toBe("invalid_request");
    expect(
      (yield* service.bind(threadId, { ...binding, correlationId: "other" }).pipe(Effect.flip))
        .reason,
    ).toBe("storage");
    expect((yield* service.bind(ThreadId.make("other"), binding).pipe(Effect.flip)).reason).toBe(
      "storage",
    );
    expect(
      (yield* service
        .bind(ThreadId.make("other"), { ...binding, readKeyHash: "short" })
        .pipe(Effect.flip)).reason,
    ).toBe("invalid_request");
    expect(
      (yield* service
        .report(threadId, { status: "progress", summary: "x".repeat(4001) })
        .pipe(Effect.flip)).reason,
    ).toBe("invalid_request");
    expect(
      (yield* service
        .report(ThreadId.make("unbound"), { status: "progress", summary: "hi" })
        .pipe(Effect.flip)).reason,
    ).toBe("not_bound");
  }));
test("records the active run, acknowledges only authenticated cursors and never reuses a sequence", ({
  service,
  sql,
  state,
}) =>
  Effect.gen(function* () {
    state.latestRunId = runB;
    state.runs.push(run(runB, "queued", 2));
    expect(yield* service.report(threadId, { status: "completed", summary: "claim" })).toEqual({
      sequence: 1,
    });
    const first = yield* service.wait(waitInput);
    expect(first).toMatchObject({
      reports: [{ sequence: 1, runId: runA, kind: "completed" }],
      observedRun: { runId: runA, status: "running", summary: null },
      latestRunId: runB,
      hasMore: false,
    });
    for (const input of [
      { ...waitInput, readKey: "2".repeat(64), afterSequence: 1 },
      { ...waitInput, correlationId: "unknown" },
    ])
      expect((yield* service.wait(input).pipe(Effect.flip)).reason).toBe("access_denied");
    expect(yield* sql`SELECT sequence FROM remote_reports`).toHaveLength(1);
    expect((yield* service.wait({ ...waitInput, afterSequence: 2 }).pipe(Effect.flip)).reason).toBe(
      "invalid_request",
    );
    yield* service.wait({ ...waitInput, afterSequence: 1, timeoutMs: 0 });
    expect(yield* sql`SELECT sequence FROM remote_reports`).toEqual([]);
    expect(yield* service.report(threadId, { status: "progress", summary: "again" })).toEqual({
      sequence: 2,
    });
    state.activeRunId = null;
    yield* service.report(threadId, { status: "needs_input", summary: "human" });
    expect(
      (yield* service.wait({ ...waitInput, afterSequence: 1 })).reports.map((item) => item.runId),
    ).toEqual([runA, null]);
  }));
test("serializes concurrent sequence allocation and drains batches beyond 50", ({ service, sql }) =>
  Effect.gen(function* () {
    const allocated = yield* Effect.forEach(
      Array.from({ length: 65 }, (_, i) => i),
      (i) => service.report(threadId, { status: "progress", summary: String(i) }),
      { concurrency: 8 },
    );
    expect(allocated.map((item) => item.sequence).toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 65 }, (_, i) => i + 1),
    );
    const first = yield* service.wait(waitInput);
    expect(first.reports).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    const second = yield* service.wait({ ...waitInput, afterSequence: 50 });
    expect(second.reports.map((item) => item.sequence)).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 51),
    );
    expect(second.hasMore).toBe(false);
    yield* service.wait({ ...waitInput, afterSequence: 65, timeoutMs: 0 });
    expect(yield* sql`SELECT sequence FROM remote_reports`).toEqual([]);
  }));
test("caps at 200, pruning oldest progress before substantive reports then oldest substantive", ({
  service,
  sql,
}) =>
  Effect.gen(function* () {
    yield* service.report(threadId, { status: "failed", summary: "keep" });
    for (let i = 0; i < 205; i++)
      yield* service.report(threadId, { status: "progress", summary: String(i) });
    const rows = yield* sql<{
      sequence: number;
      kind: string;
    }>`SELECT sequence, kind FROM remote_reports ORDER BY sequence`;
    expect(rows).toHaveLength(200);
    expect(rows[0]).toEqual({ sequence: 1, kind: "failed" });
    expect(rows[1]?.sequence).toBe(8);
    for (let i = 0; i < 201; i++)
      yield* service.report(threadId, { status: "needs_input", summary: String(i) });
    const remaining = yield* sql<{
      sequence: number;
      kind: string;
    }>`SELECT sequence, kind FROM remote_reports ORDER BY sequence`;
    expect(remaining).toHaveLength(200);
    expect(remaining.every((item) => item.kind === "needs_input")).toBe(true);
    expect(remaining[0]?.sequence).toBe(208);
  }));
test("observes completed A after B starts and summarizes only A's last assistant message", ({
  service,
  state,
}) =>
  Effect.gen(function* () {
    state.runs = [run(runA, "completed"), run(runB, "running", 2)];
    state.activeRunId = runB;
    state.latestRunId = runB;
    state.messages = [
      message("a1", runA, "early"),
      message("a2", runA, "x".repeat(5000)),
      message("a3", runA, "user", "user"),
      message("b1", runB, "wrong run"),
    ];
    const result = yield* service.wait(waitInput);
    expect(result.observedRun).toEqual({
      runId: runA,
      status: "completed",
      summary: "x".repeat(4000),
      holds: { backgroundTasks: 0, continuationPending: false },
      observation: {
        pullRequests: [],
        needsYou: [],
        result: { runId: runA, observedCheckPending: true },
      },
    });
    expect(result.latestRunId).toBe(runB);
    const latest = yield* service.wait({ ...waitInput, watchRunId: null });
    expect(latest.observedRun).toEqual({
      runId: runB,
      status: "running",
      summary: null,
      pendingRequestIds: [],
      observation: { pullRequests: [], needsYou: [] },
    });
    expect(
      (yield* service.wait({ ...waitInput, watchRunId: RunId.make("missing") }).pipe(Effect.flip))
        .reason,
    ).toBe("run_not_found");
  }));
it.effect.each(["succeeded", "failed", "cancelled", "blocked"] as const)(
  "returns the stored %s outcome for the watched terminal run",
  (outcome) =>
    withFixture(({ service, state, sql }) =>
      Effect.gen(function* () {
        state.runs = [run(runA, "completed"), run(runB, "completed", 2)];
        state.latestRunId = runB;
        state.messages = [message("a1", runA, "Assistant text is not the structured summary.")];
        const report: ThreadResultReport = { outcome, summary: "  Verified report. \n" };
        yield* sql`
          INSERT INTO thread_run_results (thread_id, run_id, report_json, reported_at)
          VALUES (${threadId}, ${runA}, ${JSON.stringify(report)}, ${"2026-10-12T00:00:00.000Z"})
        `;
        const result = yield* service.wait(waitInput);
        expect(result.observedRun).toMatchObject({
          runId: runA,
          status: "completed",
          summary: "Assistant text is not the structured summary.",
          reported: { outcome, summary: "Verified report." },
        });
        const unreported = yield* service.wait({ ...waitInput, watchRunId: runB });
        expect(unreported.observedRun).not.toHaveProperty("reported");
      }),
    ),
);

it.effect.each([undefined, " \n ", "x".repeat(4000)])(
  "omits a blank reported summary and bounds a full-length summary (%#)",
  (summary) =>
    withFixture(({ service, state, sql }) =>
      Effect.gen(function* () {
        state.runs = [run(runA, "completed")];
        const report: ThreadResultReport = {
          outcome: "succeeded",
          ...(summary === undefined ? {} : { summary }),
        };
        yield* sql`
          INSERT INTO thread_run_results (thread_id, run_id, report_json, reported_at)
          VALUES (${threadId}, ${runA}, ${JSON.stringify(report)}, ${"2026-10-12T00:00:00.000Z"})
        `;
        const result = yield* service.wait(waitInput);
        expect(result.observedRun?.reported).toEqual(
          summary?.trim()
            ? { outcome: "succeeded", summary: "x".repeat(4000) }
            : { outcome: "succeeded" },
        );
      }),
    ),
);

it.effect.each(["queued", "running"] as const)(
  "does not expose a stored result while the run is %s",
  (status) =>
    withFixture(({ service, state, sql }) =>
      Effect.gen(function* () {
        state.runs = [run(runA, status)];
        yield* sql`
          INSERT INTO thread_run_results (thread_id, run_id, report_json, reported_at)
          VALUES (${threadId}, ${runA}, ${JSON.stringify({ outcome: "failed", summary: "Still revising." })}, ${"2026-10-12T00:00:00.000Z"})
        `;
        const result = yield* service.wait({ ...waitInput, knownRun: null, timeoutMs: 0 });
        expect(result.observedRun?.status).toBe(status);
        expect(result.observedRun).not.toHaveProperty("reported");
      }),
    ),
);

test("wakes from the report PubSub with no run event", ({ service, subscribed }) =>
  Effect.gen(function* () {
    const fiber = yield* service.wait(waitInput).pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    yield* service.report(threadId, { status: "needs_input", summary: "question" });
    expect((yield* Fiber.join(fiber)).reports[0]?.summary).toBe("question");
  }));
test("a new run wakes a wait that follows the latest run", ({
  service,
  state,
  creations,
  subscribed,
}) =>
  Effect.gen(function* () {
    const fiber = yield* service.wait({ ...waitInput, watchRunId: null }).pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    const runB = RunId.make("run-new");
    state.runs = [run(runA, "running"), run(runB, "queued", 2)];
    state.latestRunId = runB;
    yield* Queue.offer(
      creations,
      stored(18, { type: "run.created", payload: run(runB, "queued", 2) }),
    );
    const result = yield* Fiber.join(fiber);
    expect(result.observedRun).toEqual({
      runId: runB,
      status: "queued",
      summary: null,
      pendingRequestIds: [],
      observation: { pullRequests: [], needsYou: [] },
    });
    expect(result.timedOut).toBe(false);
    expect(state.subscriptions).toContainEqual({
      threadId,
      afterSequence: 17,
      eventType: "run.created",
    });
  }));
test("replays a run update between initial snapshot and stream subscription", ({
  service,
  state,
  events,
}) =>
  Effect.gen(function* () {
    state.afterRead = Effect.sync(() => {
      state.runs = [run(runA, "completed")];
    }).pipe(
      Effect.andThen(
        Queue.offer(events, stored(18, { type: "run.updated", payload: run(runA, "completed") })),
      ),
      Effect.asVoid,
    );
    const result = yield* service.wait(waitInput);
    expect(result.observedRun).toEqual({
      runId: runA,
      status: "completed",
      summary: null,
      holds: { backgroundTasks: 0, continuationPending: false },
      observation: {
        pullRequests: [],
        needsYou: [],
        result: { runId: runA, observedCheckPending: true },
      },
    });
    expect(state.subscriptions).toContainEqual({
      threadId,
      afterSequence: 17,
      eventType: "run.updated",
    });
    expect(state.reads).toBe(3); // initial runs, replayed runs, terminal messages
  }));
test("ignores other run events and rereads only on the watched update", ({
  service,
  state,
  events,
  subscribed,
}) =>
  Effect.gen(function* () {
    const fiber = yield* service.wait(waitInput).pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    state.runs = [run(runA, "failed")];
    yield* Queue.offer(
      events,
      stored(18, { type: "run.updated", payload: run(runB, "running", 2) }),
    );
    yield* Queue.offer(events, stored(19, { type: "run.updated", payload: run(runA, "failed") }));
    expect((yield* Fiber.join(fiber)).observedRun?.status).toBe("failed");
    expect(state.reads).toBe(3);
  }));
test("waits on an unchanged terminal or empty thread without hot reads", ({
  service,
  state,
  subscribed,
}) =>
  Effect.gen(function* () {
    state.runs = [];
    state.activeRunId = null;
    state.latestRunId = null;
    const fiber = yield* service
      .wait({ ...waitInput, watchRunId: null, knownRun: null })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    yield* TestClock.adjust(10000);
    expect(yield* Fiber.join(fiber)).toMatchObject({
      observedRun: null,
      timedOut: true,
      reports: [],
    });
    expect(state.reads).toBe(0); // no run means no projection query, including deadline read
    state.runs = [run(runA, "completed")];
    state.latestRunId = runA;
    expect(
      yield* service.wait({
        ...waitInput,
        knownRun: { runId: runA, status: "completed" },
        timeoutMs: 0,
      }),
    ).toMatchObject({ timedOut: true, observedRun: { runId: runA, summary: null } });
  }));
test("times out using TestClock and returns a final running observation", ({
  service,
  state,
  subscribed,
}) =>
  Effect.gen(function* () {
    const fiber = yield* service.wait(waitInput).pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    yield* TestClock.adjust(10000);
    expect(yield* Fiber.join(fiber)).toMatchObject({
      timedOut: true,
      observedRun: { runId: runA, status: "running" },
    });
    expect(state.reads).toBe(2);
  }));
test("an open question releases a caller that echoes questions once, and never an older one", ({
  service,
  state,
  changes,
  subscribed,
}) =>
  Effect.gen(function* () {
    const knownRun = { runId: runA, status: "running", pendingRequestIds: [] };
    const fiber = yield* service.wait({ ...waitInput, knownRun }).pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    state.questions = ["request-1"];
    yield* changes(
      stored(18, { type: "turn-item.updated", payload: { type: "user_input_request" } }),
    );
    expect(yield* Fiber.join(fiber)).toMatchObject({
      timedOut: false,
      observedRun: { runId: runA, status: "running", pendingRequestIds: ["request-1"] },
    });
    // Echoed back, the same question no longer releases the wait.
    expect(
      (yield* service.wait({
        ...waitInput,
        knownRun: { ...knownRun, pendingRequestIds: [RuntimeRequestId.make("request-1")] },
        timeoutMs: 0,
      })).timedOut,
    ).toBe(true);
    // An origin that cannot echo questions is not released on every call while one is open.
    expect((yield* service.wait({ ...waitInput, timeoutMs: 0 })).timedOut).toBe(true);
  }));
test("a finished run reports what holds it open and releases when that changes", ({
  service,
  state,
  changes,
  subscribed,
}) =>
  Effect.gen(function* () {
    state.runs = [run(runA, "completed")];
    state.backgroundTasks = 2;
    state.continuationPending = true;
    const first = yield* service.wait({ ...waitInput, knownRun: null });
    expect(first.observedRun?.holds).toEqual({ backgroundTasks: 2, continuationPending: true });
    const knownRun = { runId: runA, status: "completed", holds: first.observedRun!.holds! };
    expect((yield* service.wait({ ...waitInput, knownRun, timeoutMs: 0 })).timedOut).toBe(true);
    const fiber = yield* service.wait({ ...waitInput, knownRun }).pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    state.backgroundTasks = 0;
    state.continuationPending = false;
    yield* changes(stored(18, { type: "provider-thread.updated", payload: {} }));
    expect(yield* Fiber.join(fiber)).toMatchObject({
      timedOut: false,
      observedRun: { holds: { backgroundTasks: 0, continuationPending: false } },
    });
  }));
const watchedPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "goat-si/goat",
  number: 42,
  url: "https://github.com/goat-si/goat/pull/42",
  source: "agent",
  linkedAt: "2026-10-12T00:00:00.000Z",
  snapshot: null,
  stack: null,
  watch: {
    startedAt: "2026-10-12T00:00:00.000Z",
    headSha: null,
    failedChecks: [],
    passed: false,
    passedChecks: [],
    remarksThrough: "2026-10-12T00:00:00.000Z",
    remarkIds: [],
    conflicting: false,
    wakes: 0,
  },
};
test("a pull request observation wakes an origin that echoes it and waits once echoed", ({
  service,
  state,
  changes,
  subscribed,
}) =>
  Effect.gen(function* () {
    const knownRun = {
      runId: runA,
      status: "running",
      observation: { pullRequests: [], needsYou: [] },
    };
    const fiber = yield* service.wait({ ...waitInput, knownRun }).pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    state.shell = { ...state.shell, pullRequests: [watchedPullRequest] };
    yield* changes(
      stored(18, { type: "thread.pull-request-link-updated", payload: watchedPullRequest }),
    );
    const changed = yield* Fiber.join(fiber);
    const observation = {
      pullRequests: [
        {
          repository: "goat-si/goat",
          number: 42,
          url: "https://github.com/goat-si/goat/pull/42",
          watching: true,
        },
      ],
      needsYou: [],
    };
    expect(changed).toMatchObject({ timedOut: false, observedRun: { observation } });
    expect(RemoteReportService.observedRunChanged(knownRun, changed.observedRun)).toBe(true);
    expect(RemoteReportService.observedRunChanged(waitInput.knownRun, changed.observedRun)).toBe(
      false,
    );
    expect(
      (yield* service.wait({
        ...waitInput,
        knownRun: { ...knownRun, observation },
        timeoutMs: 0,
      })).timedOut,
    ).toBe(true);
    // An older origin never echoes observations, so a PR cannot make it spin.
    expect((yield* service.wait({ ...waitInput, timeoutMs: 0 })).timedOut).toBe(true);
    state.shell = { ...state.shell, pullRequests: [] };
    expect(
      (yield* service.wait({
        ...waitInput,
        knownRun: { ...knownRun, observation },
        timeoutMs: 0,
      })).timedOut,
    ).toBe(false);
  }));
test("a completed run stays held by its watched pull request without provider background tasks", ({
  service,
  state,
}) =>
  Effect.gen(function* () {
    state.runs = [run(runA, "completed")];
    state.activeRunId = null;
    state.shell = { ...state.shell, pullRequests: [watchedPullRequest] };
    const result = yield* service.wait(waitInput);
    expect(result.observedRun?.holds?.backgroundTasks).toBeGreaterThanOrEqual(1);
    expect(result.observedRun?.observation).toEqual({
      result: { runId: runA, observedCheckPending: true },
      pullRequests: [
        {
          repository: "goat-si/goat",
          number: 42,
          url: "https://github.com/goat-si/goat/pull/42",
          watching: true,
        },
      ],
      needsYou: [],
    });
  }));
it.effect.each(["unknown reset", "unchosen recovery", "auto resume"] as const)(
  "reports a failed usage-limited run with %s without arming recovery",
  (choice) =>
    withFixture(({ service, state }) =>
      Effect.gen(function* () {
        const resetAt = "2099-01-01T00:00:00.000Z";
        state.runs = [{ ...run(runA, "failed"), completedAt: DateTime.makeUnsafe(0) }];
        state.activeRunId = null;
        state.shell = {
          lastErrorClass: "usage_limit",
          ...(choice === "unknown reset" ? {} : { usageLimitResetAt: resetAt }),
          ...(choice === "auto resume"
            ? {
                limitRecovery: { runId: runA, resetAt, autoResume: true, snooze: false },
              }
            : {}),
        };
        const result = yield* service.wait(waitInput);
        expect(result.observedRun).toMatchObject({ runId: runA, status: "failed" });
        expect(result.observedRun?.observation).toEqual({
          pullRequests: [],
          needsYou:
            choice === "auto resume"
              ? []
              : [
                  {
                    kind: "usage_limit",
                    since: "1970-01-01T00:00:00.000Z",
                  },
                ],
          ...(choice === "unknown reset" ? {} : { usageLimitResetAt: resetAt }),
        });
      }),
    ),
);
test("unbind removes reports, wakes waiters and blocks future reports", ({
  service,
  sql,
  subscribed,
}) =>
  Effect.gen(function* () {
    yield* service.report(threadId, { status: "progress", summary: "data" });
    const fiber = yield* service
      .wait({ ...waitInput, afterSequence: 1 })
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(subscribed);
    yield* service.unbind(threadId);
    const result = yield* Fiber.join(fiber);
    expect(result._tag === "Failure" && result.failure.reason).toBe("access_denied");
    expect(yield* sql`SELECT * FROM remote_report_bindings`).toEqual([]);
    expect(yield* sql`SELECT * FROM remote_reports`).toEqual([]);
    expect(
      (yield* service.report(threadId, { status: "progress", summary: "late" }).pipe(Effect.flip))
        .reason,
    ).toBe("not_bound");
  }));
test("thread deletion wakes the wait into a thread_deleted error", ({
  service,
  state,
  changes,
  subscribed,
}) =>
  Effect.gen(function* () {
    const fiber = yield* service.wait(waitInput).pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(subscribed);
    state.deletedAt = "2026-10-12T00:00:00.000Z";
    const refused = yield* service
      .report(threadId, { status: "progress", summary: "late" })
      .pipe(Effect.flip);
    expect(refused.reason).toBe("thread_deleted");
    yield* changes(stored(18, { type: "thread.deleted", payload: { threadId } }));
    const result = yield* Fiber.join(fiber);
    expect(result._tag === "Failure" && result.failure.reason).toBe("thread_deleted");
  }));
it.effect.each(["completed", "failed", "interrupted", "cancelled", "rolled_back"] as const)(
  "observes terminal %s without an explicit report",
  (status) =>
    withFixture(({ service, state }) =>
      Effect.gen(function* () {
        state.runs = [run(runA, status)];
        const result = yield* service.wait(waitInput);
        expect(result).toMatchObject({
          reports: [],
          timedOut: false,
          observedRun: { runId: runA, status, summary: null },
        });
      }),
    ),
);
test("rolls sequence allocation back when report insertion fails", ({ service, sql }) =>
  Effect.gen(function* () {
    yield* sql`CREATE TRIGGER refuse_report BEFORE INSERT ON remote_reports BEGIN SELECT RAISE(ABORT, 'fixture'); END`;
    expect(
      (yield* service
        .report(threadId, { status: "progress", summary: "rollback" })
        .pipe(Effect.flip)).reason,
    ).toBe("storage");
    expect(yield* sql`SELECT last_sequence FROM remote_report_bindings`).toEqual([
      { last_sequence: 0 },
    ]);
    yield* sql`DROP TRIGGER refuse_report`;
    expect(yield* service.report(threadId, { status: "progress", summary: "retry" })).toEqual({
      sequence: 1,
    });
  }));
test("deadline reread sees a durable change even without a signal", ({
  service,
  state,
  subscribed,
}) =>
  Effect.gen(function* () {
    const fiber = yield* service.wait(waitInput).pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    // Script a durable projection change without offering a stream event.
    state.runs = [run(runA, "completed")];
    yield* TestClock.adjust(10000);
    expect(yield* Fiber.join(fiber)).toMatchObject({
      timedOut: false,
      observedRun: { runId: runA, status: "completed" },
    });
  }));

test("relay receipts survive collection and service recreation and remain scoped to the binding", ({
  service,
  sql,
  recreate,
}) =>
  Effect.gen(function* () {
    const relaying = ThreadId.make("receipt-thread");
    yield* service.bind(relaying, {
      ...binding,
      correlationId: "receipt-correlation",
      relaySend: true,
    });
    const input = {
      host: "box",
      threadId: ThreadId.make("review-child"),
      message: "Steer once",
      clientRequestId: "durable-request",
    };
    const first = yield* service.relay(relaying, input);
    // Collection prunes the report payload, while the request identity stays.
    yield* sql`DELETE FROM remote_reports WHERE correlation_id = 'receipt-correlation'`;
    const restarted = yield* recreate;
    expect(yield* restarted.relayReceipt(relaying, input.clientRequestId)).toEqual({
      sequence: first.sequence,
      originLabel: binding.originLabel,
    });
    expect(yield* restarted.relay(relaying, input)).toEqual(first);
    expect(yield* restarted.relayReceipt(threadId, input.clientRequestId)).toBeNull();
    expect(yield* restarted.relayReceipt(relaying, "new-request")).toBeNull();
    yield* restarted.unbind(relaying);
    expect(yield* restarted.relayReceipt(relaying, input.clientRequestId)).toBeNull();
  }));

it.effect.each(["initial", "wakeup"] as const)(
  "a projection defect when subagents is missing on %s read fails the wait promptly instead of hanging",
  (phase) =>
    withFixture(({ service, state, events, subscribed }) =>
      Effect.gen(function* () {
        if (phase === "initial") state.subagents = undefined;
        const fiber = yield* service.wait(waitInput).pipe(Effect.forkChild);
        const subscribedExit = yield* Effect.exit(Deferred.await(subscribed));
        if (phase === "wakeup") {
          expect(Exit.isSuccess(subscribedExit)).toBe(true);
          state.subagents = undefined;
          yield* Queue.offer(
            events,
            stored(18, { type: "run.updated", payload: run(runA, "running") }),
          );
        } else {
          expect(Exit.isFailure(subscribedExit) && Cause.hasDies(subscribedExit.cause)).toBe(true);
        }
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      }),
    ),
);

test("returns late check evidence from the watched run only, after an authenticated wait", ({
  service,
  state,
  sql,
  subscribed,
}) =>
  Effect.gen(function* () {
    state.runs = [run(runA, "completed")];
    state.activeRunId = null;
    yield* sql`INSERT INTO thread_run_results (thread_id, run_id, report_json, reported_at)
      VALUES (${threadId}, ${runA}, ${JSON.stringify({ outcome: "succeeded", tests: { ok: true, passed: 12 } })}, '2026-10-12T00:00:00.000Z')`;
    const first = yield* service.wait({ ...waitInput, timeoutMs: 0 });
    expect(first.observedRun?.observation?.result).toEqual({
      runId: runA,
      tests: { ok: true, passed: 12 },
      observedCheckPending: true,
    });
    const waiting = yield* service
      .wait({ ...waitInput, knownRun: first.observedRun })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    yield* sql`INSERT INTO thread_run_observed_checks (thread_id, run_id, status, command, exit_code, duration_ms, started_at, output_tail)
      VALUES (${threadId}, ${runA}, 'completed', 'vp test run', 3, 1250, '2026-10-12T00:00:00.000Z', 'one test failed')`;
    // The existing wait timeout re-reads evidence even without another run event.
    yield* TestClock.adjust(waitInput.timeoutMs);
    const late = yield* Fiber.join(waiting);
    expect(late.timedOut).toBe(false);
    expect(late.observedRun?.reported?.outcome).toBe("succeeded");
    expect(late.observedRun?.observation?.result).toEqual({
      runId: runA,
      tests: { ok: true, passed: 12 },
      observedCheckPending: false,
      observedCheck: {
        status: "completed",
        command: "vp test run",
        exitCode: 3,
        durationMs: 1250,
        at: "2026-10-12T00:00:00.000Z",
        outputTail: "one test failed",
      },
    });
    expect(
      (yield* service
        .wait({ ...waitInput, readKey: "2".repeat(64), timeoutMs: 0 })
        .pipe(Effect.flip)).reason,
    ).toBe("access_denied");
    state.runs.push(run(runB, "completed", 2));
    state.latestRunId = runB;
    const other = yield* service.wait({ ...waitInput, watchRunId: runB, timeoutMs: 0 });
    expect(other.observedRun?.observation?.result?.observedCheck).toBeUndefined();
    expect(other.observedRun?.observation?.result?.tests).toBeUndefined();
    const unchanged = yield* service.wait({
      ...waitInput,
      knownRun: late.observedRun,
      timeoutMs: 0,
    });
    expect(unchanged.timedOut).toBe(true);
  }));
