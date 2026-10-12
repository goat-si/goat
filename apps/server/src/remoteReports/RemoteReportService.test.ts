// @effect-diagnostics nodeBuiltinImport:off - the origin side hashes its read key with node:crypto.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import {
  ThreadId,
  RunId,
  RuntimeRequestId,
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2StoredEvent,
} from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import migration from "../persistence/Migrations/063_RemoteReports.ts";
import dispatchMigration from "../persistence/Migrations/064_RemoteDispatches.ts";
import relayMigration from "../persistence/Migrations/068_RemoteReportRelay.ts";
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
  yield* relayMigration;
  const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const deletions = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const creations = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const subscribed = yield* Deferred.make<void>();
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
          })),
          providerThreads: [
            {
              pendingBackgroundTasks: Array.from({ length: state.backgroundTasks }, (_, i) => ({
                taskId: `background-${i}`,
              })),
            },
          ],
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
          : Stream.fromQueue(deletions);
    },
  });
  const context = yield* Layer.build(RemoteReportService.layer.pipe(Layer.provide(fake)));
  const service = Context.get(context, RemoteReportService.RemoteReportService);
  yield* service.bind(threadId, binding);
  return { service, sql, state, events, deletions, creations, subscribed };
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
    });
    expect(result.latestRunId).toBe(runB);
    const latest = yield* service.wait({ ...waitInput, watchRunId: null });
    expect(latest.observedRun).toEqual({
      runId: runB,
      status: "running",
      summary: null,
      pendingRequestIds: [],
    });
    expect(
      (yield* service.wait({ ...waitInput, watchRunId: RunId.make("missing") }).pipe(Effect.flip))
        .reason,
    ).toBe("run_not_found");
  }));
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
  deletions,
  subscribed,
}) =>
  Effect.gen(function* () {
    const knownRun = { runId: runA, status: "running", pendingRequestIds: [] };
    const fiber = yield* service.wait({ ...waitInput, knownRun }).pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    state.questions = ["request-1"];
    yield* Queue.offer(
      deletions,
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
  deletions,
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
    yield* Queue.offer(deletions, stored(18, { type: "provider-thread.updated", payload: {} }));
    expect(yield* Fiber.join(fiber)).toMatchObject({
      timedOut: false,
      observedRun: { holds: { backgroundTasks: 0, continuationPending: false } },
    });
  }));
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
  deletions,
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
    yield* Queue.offer(deletions, stored(18, { type: "thread.deleted", payload: { threadId } }));
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
