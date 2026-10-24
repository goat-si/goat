import { assert, describe, it } from "@effect/vitest";
import {
  ChannelDispatchTarget,
  ChannelInboundMessage,
  ChannelRequester,
  ChannelTask,
  ChannelTaskEvent,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelChildWork from "./ChannelChildWork.ts";
import * as ChannelChildWorkStore from "./channelChildWorkStore.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import {
  bindingIdFor,
  childWorkCorrelationIdFor,
  contentHashFor,
  conversationIdFor,
  inputIdFor,
  taskEventIdFor,
  taskIdFor,
} from "./channelIds.ts";
import { prepareTransition, type ChannelTaskEventSpec } from "./channelTaskWrites.ts";

const NOW = "2026-10-12T00:00:00.000Z";
const workerThread = ThreadId.make("worker-1");
const childThread = ThreadId.make("child-1");

const decodeMessage = Schema.decodeUnknownSync(ChannelInboundMessage);
const decodeRequester = Schema.decodeUnknownSync(ChannelRequester);
const decodeTask = Schema.decodeUnknownSync(ChannelTask);
const decodeEvent = Schema.decodeUnknownSync(ChannelTaskEvent);
const decodeTarget = Schema.decodeUnknownSync(ChannelDispatchTarget);
const isChildWorkError = Schema.is(ChannelChildWork.ChannelChildWorkError);

const slackMessage = decodeMessage({
  kind: "slack",
  connectionId: "slack-1",
  conversationKey: "T1:C1:1760000000.000100",
  externalMessageId: "1760000000.000200",
  idempotencyKey: "T1:Ev1",
  actor: { externalActorId: "U1" },
  replyAddress: {
    kind: "slack",
    connectionId: "slack-1",
    teamId: "T1",
    channelId: "C1",
    rootTs: "1760000000.000100",
  },
  text: "Audit the release.",
  attachments: [],
  receivedAt: NOW,
  intent: "message",
});

const requester = decodeRequester({
  ownerId: "owner",
  principalId: "owner",
  displayName: "Jun",
  originKind: "slack",
  externalActorId: "U1",
  runtimeModeCeiling: "approval-required",
  grantedScopes: ["orchestration:read", "orchestration:operate"],
});

const target = decodeTarget({
  environmentId: "env-1",
  projectId: "project-1",
  modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
});

/** A run record as reconcileLocal reads it: ordinal for recency, status for the state map. */
const fakeRun = (status: string, ordinal = 1) => ({ id: "run-1", status, ordinal });

const unused = () => Effect.die("Unexpected test dependency call");

interface DispatchedStop {
  readonly commandId: string;
  readonly threadId: string;
  readonly stopDelegatedTasks: boolean | undefined;
}

const threadsLayer = (
  runs: ReadonlyMap<string, ReadonlyArray<unknown>>,
  failures: ReadonlyMap<string, unknown> = new Map(),
  dispatched: Array<DispatchedStop> = [],
  providerThreads: ReadonlyMap<string, ReadonlyArray<unknown>> = new Map(),
) =>
  Layer.succeed(
    ThreadManagementService.ThreadManagementService,
    ThreadManagementService.ThreadManagementService.of({
      getLaunchedPendingQuestions: unused,
      assertReviewTaskSendAllowed: unused,
      listActiveSubagentThreadIds: unused,
      getThreadShell: unused,
      getShellSnapshot: unused,
      readShellSnapshot: unused,
      ensureLegacyTranscript: unused,
      dispatch: ((command: {
        readonly type: string;
        readonly commandId: string;
        readonly threadId?: string;
        readonly stopDelegatedTasks?: boolean;
      }) => {
        if (command.threadId === undefined) return Effect.die("unexpected non-thread command");
        dispatched.push({
          commandId: command.commandId,
          threadId: command.threadId,
          stopDelegatedTasks: command.stopDelegatedTasks,
        });
        const failure = failures.get(command.threadId);
        return failure === undefined
          ? Effect.succeed({ sequence: 0, storedEvents: [] } as never)
          : Effect.fail(failure as never);
      }) as never,
      searchThread: unused,
      searchThreadStream: () => Stream.empty,
      getThreadHistoryPage: unused,
      getTimelinePage: unused,
      getMessageCount: unused,
      getTurnItem: unused,
      getReviewLedgerEntries: unused,
      getThreadRecords: ((threadId: ThreadId) =>
        Effect.succeed({
          thread: {
            id: threadId,
            projectId: "project-1",
            archivedAt: null,
            deletedAt: null,
            pullRequests: [],
            updatedAt: NOW,
            activeProviderThreadId: null,
          },
          runs: runs.get(threadId) ?? [],
          runtimeRequests: [],
          turnItems: [],
          providerThreads: providerThreads.get(threadId) ?? [],
          subagents: [],
          messages: [],
        } as never)) as never,
      getThreadProjection: unused,
      getCheckpointContext: unused,
      getThreadSnapshot: unused,
      getThreadTranscript: unused,
      getThreadSnapshotWindow: unused,
      getProjectThreadRecords: unused,
      getProjectThread: unused,
      listProjectThreads: unused,
      sendToThread: unused,
      assertProviderInstanceEnabled: unused,
      isProviderInstanceEnabledForProject: unused,
      hasReceipt: unused,
      receiptStatus: unused,
      waitForThread: unused,
      settleAfterRun: unused,
      settleThread: unused,
      interruptThread: unused,
      stopWorkflow: unused,
      stopDelegatedTasks: unused,
      getThreadEventSequence: unused,
      recoverDelegatedTask: unused,
      delegatedTaskResultPending: unused,
      streamStoredEvents: Stream.empty,
      streamStoredEventsFrom: () => Stream.empty,
      streamDomainEvents: Stream.empty,
    }),
  );

const makeLayer = (
  runs: ReadonlyMap<string, ReadonlyArray<unknown>> = new Map(),
  failures: ReadonlyMap<string, unknown> = new Map(),
  dispatched: Array<DispatchedStop> = [],
  providerThreads: ReadonlyMap<string, ReadonlyArray<unknown>> = new Map(),
) =>
  ChannelChildWork.layer.pipe(
    Layer.provideMerge(ChannelChildWorkStore.layer),
    Layer.provideMerge(ChannelLedger.layer),
    Layer.provideMerge(threadsLayer(runs, failures, dispatched, providerThreads)),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const accept = () => {
  const conversationId = conversationIdFor({
    ownerId: "owner",
    kind: slackMessage.kind,
    connectionId: slackMessage.connectionId,
    conversationKey: slackMessage.conversationKey,
  });
  return ChannelLedger.ChannelLedger.pipe(
    Effect.flatMap((ledger) =>
      ledger.acceptInput({
        ownerId: "owner",
        inputId: inputIdFor({
          ownerId: "owner",
          kind: slackMessage.kind,
          connectionId: slackMessage.connectionId,
          idempotencyKey: slackMessage.idempotencyKey,
        }),
        conversationId,
        bindingId: bindingIdFor(conversationId, "root"),
        message: slackMessage,
        contentHash: contentHashFor(slackMessage),
        requester,
        acceptedAt: NOW,
      }),
    ),
  );
};

const move = (taskId: ChannelTask["taskId"], spec: ChannelTaskEventSpec) =>
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const stored = yield* ledger.getTask(taskId);
    if (stored === undefined) return yield* Effect.die("task missing");
    const prepared = prepareTransition(stored, spec, NOW, undefined);
    if (!prepared.ok) return yield* Effect.die("transition rejected: " + prepared.reason);
    yield* ledger.applyTaskEvent({
      owner: "cw-owner",
      write: prepared.write,
      deliveries: prepared.deliveries,
    });
  });

/** A channel task in generation 1 whose bound worker is workerThread. */
const seedWorker = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  yield* ledger.claimOwnership({
    token: "cw-owner",
    now: NOW,
    staleBefore: "2026-10-11T23:59:30.000Z",
  });
  const input = yield* accept();
  yield* ledger.beginReception({
    owner: "cw-owner",
    inputId: input.inputId,
    receptionId: "cw-r" as never,
    readAt: NOW,
  });
  const taskId = taskIdFor(input.inputId, 0);
  const task = decodeTask({
    taskId,
    conversationId: input.conversationId,
    originBindingId: input.bindingId,
    originAddress: slackMessage.replyAddress,
    originInputId: input.inputId,
    requester,
    title: "Audit the release.",
    instruction: "Audit the release.",
    status: "received",
    version: 1,
    generation: 1,
    openQuestions: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const event = decodeEvent({
    eventId: taskEventIdFor(taskId, 1),
    sequence: 0,
    taskId,
    taskVersion: 1,
    occurredAt: NOW,
    actor: "system",
    type: "task.created",
    payload: { title: task.title, instruction: task.instruction, originInputId: input.inputId },
  });
  yield* ledger.completeReception({
    owner: "cw-owner",
    inputId: input.inputId,
    receptionId: "cw-r" as never,
    replyText: "Starting.",
    decision: { replyText: "Starting.", action: { type: "report_only" } },
    createdTask: { task, event },
    deliveries: [],
    now: NOW,
  });
  yield* move(taskId, {
    type: "task.dispatch.claimed",
    payload: { generation: 1, target, leaseExpiresAt: NOW },
  });
  yield* move(taskId, {
    type: "task.worker.bound",
    payload: {
      worker: {
        environmentId: "env-1" as never,
        threadId: workerThread as never,
        runId: "run-1" as never,
        generation: 1,
      },
    },
  });
  return taskId;
});

const admit = (
  prompt: string,
  options?: {
    readonly callerThreadId?: ThreadId;
    readonly surface?: "delegate_local" | "delegate_remote" | "thread_launch" | "ssh_thread_launch";
    readonly destinationKey?: string;
    readonly clientRequestId?: string;
  },
) =>
  ChannelChildWork.ChannelChildWork.pipe(
    Effect.flatMap((childWork) =>
      childWork.admit({
        callerThreadId: options?.callerThreadId ?? workerThread,
        surface: options?.surface ?? "delegate_local",
        prompt,
        destinationKey: options?.destinationKey ?? "codex/gpt-6.1-sol",
        ...(options?.clientRequestId === undefined
          ? {}
          : { clientRequestId: options.clientRequestId }),
      }),
    ),
  );

describe("ChannelChildWork admission", () => {
  it.effect("a caller outside channel work is never recorded", () =>
    Effect.gen(function* () {
      const admission = yield* admit("hello", { callerThreadId: ThreadId.make("stranger") });
      assert.strictEqual(admission._tag, "not_channel_owned");
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      const taskId = yield* seedWorker;
      assert.deepStrictEqual(yield* store.listForTask(taskId), []);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("admits up to the descendant budget, then refuses at capacity", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const first = yield* admit("one");
      const second = yield* admit("two");
      assert.strictEqual(first._tag, "admitted");
      assert.strictEqual(second._tag, "admitted");
      const third = yield* Effect.flip(admit("three"));
      assert.strictEqual(third.reason, "at_capacity");
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual((yield* store.listForTask(taskId)).length, 2);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("serializes racing admissions so the budget cannot be overrun", () =>
    Effect.gen(function* () {
      yield* seedWorker;
      const outcomes = yield* Effect.forEach(
        ["a", "b", "c", "d"],
        (key) => Effect.result(admit("concurrent " + key)),
        { concurrency: 4 },
      );
      const admitted = outcomes.filter((outcome) => outcome._tag === "Success");
      const refused = outcomes.filter(
        (outcome) =>
          outcome._tag === "Failure" &&
          isChildWorkError(outcome.failure) &&
          outcome.failure.reason === "at_capacity",
      );
      assert.strictEqual(admitted.length, ChannelChildWork.CHANNEL_CHILD_WORK_MAX_ACTIVE);
      assert.strictEqual(refused.length, 4 - ChannelChildWork.CHANNEL_CHILD_WORK_MAX_ACTIVE);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("returns capacity when a descendant settles, so a coordinator never deadlocks", () =>
    Effect.gen(function* () {
      yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const first = yield* admit("one");
      const second = yield* admit("two");
      assert.strictEqual(first._tag, "admitted");
      assert.strictEqual(second._tag, "admitted");
      if (first._tag !== "admitted") return yield* Effect.die("expected admission");
      yield* childWork.markLaunched(first.record, { threadId: childThread });
      yield* childWork.markTerminal(first.record, "completed");
      const third = yield* admit("three");
      assert.strictEqual(third._tag, "admitted");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("a recorded child cannot admit its own descendant", () =>
    Effect.gen(function* () {
      yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const admission = yield* admit("delegate");
      if (admission._tag === "not_channel_owned") return yield* Effect.die("expected ownership");
      yield* childWork.markLaunched(admission.record, { threadId: childThread });
      const nested = yield* Effect.flip(admit("nested", { callerThreadId: childThread }));
      assert.strictEqual(nested.reason, "depth_exceeded");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("a keyless retry reuses its record instead of reserving twice", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const first = yield* admit("same request");
      const retry = yield* admit("same request");
      assert.strictEqual(first._tag, "admitted");
      assert.strictEqual(retry._tag, "existing");
      if (first._tag === "not_channel_owned" || retry._tag === "not_channel_owned")
        return yield* Effect.die("expected ownership");
      assert.strictEqual(retry.record.childWorkId, first.record.childWorkId);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual((yield* store.listForTask(taskId)).length, 1);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("a stable clientRequestId anchors the retry; a new one is a new request", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const first = yield* admit("keyed", { clientRequestId: "req-1" });
      const retry = yield* admit("keyed", { clientRequestId: "req-1" });
      assert.strictEqual(first._tag, "admitted");
      assert.strictEqual(retry._tag, "existing");
      const distinct = yield* admit("keyed", { clientRequestId: "req-2" });
      assert.strictEqual(distinct._tag, "admitted");
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual((yield* store.listForTask(taskId)).length, 2);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("releaseReserved frees a reservation but never settles launched work", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const first = yield* admit("reserved one");
      const second = yield* admit("reserved two");
      if (first._tag !== "admitted" || second._tag !== "admitted")
        return yield* Effect.die("expected admissions");
      yield* childWork.releaseReserved(first.record);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual((yield* store.get(taskId, first.record.childWorkId))?.state, "released");
      yield* childWork.markLaunched(second.record, { threadId: childThread });
      yield* childWork.releaseReserved(second.record);
      assert.strictEqual((yield* store.get(taskId, second.record.childWorkId))?.state, "launched");
      // The first slot came back and the second stays held: exactly one more admission fits.
      const third = yield* admit("three");
      assert.strictEqual(third._tag, "admitted");
      const fourth = yield* Effect.flip(admit("four"));
      assert.strictEqual(fourth.reason, "at_capacity");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses new child work once the owning task is terminal", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      yield* move(taskId, { type: "task.cancelled", payload: { reason: "Stop" } });
      const error = yield* Effect.flip(admit("too late"));
      assert.strictEqual(error.reason, "owner_terminal");
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.deepStrictEqual(yield* store.listForTask(taskId), []);
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("ChannelChildWork reconcile", () => {
  it.effect("releases a reservation whose owning task went terminal", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const admission = yield* admit("reserved");
      if (admission._tag === "not_channel_owned") return yield* Effect.die("expected ownership");
      yield* move(taskId, { type: "task.cancelled", payload: { reason: "Stop" } });
      assert.strictEqual(yield* childWork.reconcile, 1);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      const record = yield* store.get(taskId, admission.record.childWorkId);
      assert.strictEqual(record?.state, "released");
      // A terminal owner admits nothing new; the release keeps the accounting honest.
      const next = yield* Effect.flip(admit("after release"));
      assert.strictEqual(next.reason, "owner_terminal");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("settles a bound local record from its child run", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const admission = yield* admit("local work");
      if (admission._tag === "not_channel_owned") return yield* Effect.die("expected ownership");
      yield* childWork.markLaunched(admission.record, { threadId: childThread });
      yield* childWork.markBound(admission.record, { threadId: childThread });
      assert.strictEqual(yield* childWork.reconcile, 1);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      const record = yield* store.get(taskId, admission.record.childWorkId);
      assert.strictEqual(record?.state, "completed");
    }).pipe(Effect.provide(makeLayer(new Map([[childThread, [fakeRun("completed")]]])))),
  );

  it.effect("keeps capacity while a local child is still starting or running", () =>
    Effect.gen(function* () {
      yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const first = yield* admit("local one");
      const second = yield* admit("local two");
      if (first._tag === "not_channel_owned" || second._tag === "not_channel_owned")
        return yield* Effect.die("expected ownership");
      yield* childWork.markBound(first.record, { threadId: childThread });
      yield* childWork.markBound(second.record, { threadId: ThreadId.make("child-2") });
      // child-2 has no runs at all: still starting, so the slot stays held.
      assert.strictEqual(yield* childWork.reconcile, 0);
      const third = yield* Effect.flip(admit("local three"));
      assert.strictEqual(third.reason, "at_capacity");
    }).pipe(Effect.provide(makeLayer(new Map([[childThread, [fakeRun("running")]]])))),
  );

  it.effect("binds a live remote dispatch and keeps a lost one's capacity as unknown", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* admit("remote work", { surface: "delegate_remote" });
      if (admission._tag === "not_channel_owned") return yield* Effect.die("expected ownership");
      const correlationId = childWorkCorrelationIdFor(admission.record.childWorkId);
      yield* childWork.markLaunched(admission.record, { correlationId, host: "box" });
      const insertRow = (state: string) =>
        sql`INSERT INTO remote_dispatches
          (correlation_id, kind, origin_thread_id, host, read_key, delivery, state, created_at, updated_at)
          VALUES (${correlationId}, 'thread', ${admission.record.callerThreadId}, 'box', 'read-key', 'wake', ${state}, ${NOW}, ${NOW})`;
      yield* insertRow("running");
      assert.strictEqual(yield* childWork.reconcile, 1);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual((yield* store.get(taskId, admission.record.childWorkId))?.state, "bound");
      yield* sql`UPDATE remote_dispatches SET state = 'lost' WHERE correlation_id = ${correlationId}`;
      assert.strictEqual(yield* childWork.reconcile, 1);
      assert.strictEqual(
        (yield* store.get(taskId, admission.record.childWorkId))?.state,
        "unknown",
      );
      // Unknown keeps the slot: only PR-D's resolve-or-fence may release it.
      yield* admit("second remote", { surface: "delegate_remote" });
      const refused = yield* Effect.flip(admit("third remote", { surface: "delegate_remote" }));
      assert.strictEqual(refused.reason, "at_capacity");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "keeps a launched remote record whose dispatch row is not yet visible while the task is live",
    () =>
      Effect.gen(function* () {
        const taskId = yield* seedWorker;
        const childWork = yield* ChannelChildWork.ChannelChildWork;
        const admission = yield* admit("remote in flight", { surface: "delegate_remote" });
        if (admission._tag === "not_channel_owned") return yield* Effect.die("expected ownership");
        const correlationId = childWorkCorrelationIdFor(admission.record.childWorkId);
        // markLaunched precedes the dispatch-row insert inside the launch call, so a reconcile
        // pass racing that window must hold the record and its capacity.
        yield* childWork.markLaunched(admission.record, { correlationId, host: "box" });
        assert.strictEqual(yield* childWork.reconcile, 0);
        const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
        assert.strictEqual(
          (yield* store.get(taskId, admission.record.childWorkId))?.state,
          "launched",
        );
        const second = yield* admit("second remote", { surface: "delegate_remote" });
        assert.strictEqual(second._tag, "admitted");
        const refused = yield* Effect.flip(admit("third remote", { surface: "delegate_remote" }));
        assert.strictEqual(refused.reason, "at_capacity");
      }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "releases a launched remote record whose dispatch row never landed once the task settles",
    () =>
      Effect.gen(function* () {
        const taskId = yield* seedWorker;
        const childWork = yield* ChannelChildWork.ChannelChildWork;
        const admission = yield* admit("remote lost pre-row", { surface: "delegate_remote" });
        if (admission._tag === "not_channel_owned") return yield* Effect.die("expected ownership");
        const correlationId = childWorkCorrelationIdFor(admission.record.childWorkId);
        yield* childWork.markLaunched(admission.record, { correlationId, host: "box" });
        yield* move(taskId, { type: "task.cancelled", payload: { reason: "Stop" } });
        assert.strictEqual(yield* childWork.reconcile, 1);
        const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
        assert.strictEqual(
          (yield* store.get(taskId, admission.record.childWorkId))?.state,
          "released",
        );
        // A terminal owner admits nothing new; the release keeps the accounting honest.
        const next = yield* Effect.flip(admit("after release", { surface: "delegate_remote" }));
        assert.strictEqual(next.reason, "owner_terminal");
      }).pipe(Effect.provide(makeLayer())),
  );
});

describe("ChannelChildWork cancelForTask", () => {
  it.effect("stops launched thread children and releases reservations on a task stop", () => {
    const dispatched: Array<DispatchedStop> = [];
    return Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const launched = yield* admit("thread child", { surface: "thread_launch" });
      const reserved = yield* admit("reserved child", {
        surface: "thread_launch",
        destinationKey: "other-host",
      });
      if (launched._tag !== "admitted" || reserved._tag !== "admitted")
        return yield* Effect.die("expected admission");
      yield* childWork.markLaunched(launched.record, { threadId: childThread });
      const outcome = yield* childWork.cancelForTask({
        taskId,
        generation: 1,
        stopEventId: taskEventIdFor(taskId, 99),
        attempt: 0,
        reason: "Stopped.",
      });
      assert.strictEqual(outcome, "settled");
      assert.deepStrictEqual(
        dispatched.map((entry) => ({
          threadId: entry.threadId,
          stopDelegatedTasks: entry.stopDelegatedTasks,
        })),
        [{ threadId: childThread, stopDelegatedTasks: true }],
      );
      assert.include(dispatched[0]!.commandId, "channel-stop-child");
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual(
        (yield* store.get(taskId, launched.record.childWorkId))?.state,
        "cancelled",
      );
      assert.strictEqual(
        (yield* store.get(taskId, reserved.record.childWorkId))?.state,
        "released",
      );
    }).pipe(Effect.provide(makeLayer(new Map(), new Map(), dispatched)));
  });

  it.effect("leaves delegated children to the worker's own cascade", () => {
    const dispatched: Array<DispatchedStop> = [];
    return Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const delegate = yield* admit("delegate child");
      const thread = yield* admit("thread child", { surface: "thread_launch" });
      if (delegate._tag !== "admitted" || thread._tag !== "admitted")
        return yield* Effect.die("expected admission");
      yield* childWork.markLaunched(delegate.record, {
        threadId: ThreadId.make("delegate-1"),
      });
      yield* childWork.markLaunched(thread.record, { threadId: childThread });
      const outcome = yield* childWork.cancelForTask({
        taskId,
        generation: 1,
        stopEventId: taskEventIdFor(taskId, 99),
        attempt: 0,
        reason: "Stopped.",
      });
      assert.strictEqual(outcome, "settled");
      assert.deepStrictEqual(
        dispatched.map((entry) => entry.threadId),
        [childThread],
      );
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      // The delegate's stop arrives through the worker's subagent cascade; its record settles
      // when reconcile observes the run.
      assert.strictEqual(
        (yield* store.get(taskId, delegate.record.childWorkId))?.state,
        "launched",
      );
      assert.strictEqual((yield* store.get(taskId, thread.record.childWorkId))?.state, "cancelled");
    }).pipe(Effect.provide(makeLayer(new Map(), new Map(), dispatched)));
  });

  it.effect("advances the owning stop's attempt when a child stop is refused while live", () => {
    const dispatched: Array<DispatchedStop> = [];
    return Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const admission = yield* admit("thread child", { surface: "thread_launch" });
      if (admission._tag !== "admitted") return yield* Effect.die("expected admission");
      yield* childWork.markLaunched(admission.record, { threadId: childThread });
      const stopEventId = taskEventIdFor(taskId, 99);
      const ledger = yield* ChannelLedger.ChannelLedger;
      const first = yield* childWork.cancelForTask({
        taskId,
        generation: 1,
        stopEventId,
        attempt: 0,
        reason: "Stopped.",
      });
      assert.strictEqual(first, "retry");
      assert.strictEqual(yield* ledger.stopAttempt(stopEventId), 1);
      const second = yield* childWork.cancelForTask({
        taskId,
        generation: 1,
        stopEventId,
        attempt: 1,
        reason: "Stopped.",
      });
      assert.strictEqual(second, "retry");
      // A refused command id is refused for good, so the retry used a fresh one.
      assert.notStrictEqual(dispatched[1]!.commandId, dispatched[0]!.commandId);
      assert.strictEqual(yield* ledger.stopAttempt(stopEventId), 2);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual(
        (yield* store.get(taskId, admission.record.childWorkId))?.state,
        "launched",
      );
    }).pipe(
      Effect.provide(
        makeLayer(
          new Map([[childThread, [fakeRun("running")]]]),
          new Map([[childThread, { _tag: "OrchestratorCommandRejectedError" }]]),
          dispatched,
        ),
      ),
    );
  });

  it.effect("settles a refused child stop when the thread already ended", () => {
    const dispatched: Array<DispatchedStop> = [];
    return Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const admission = yield* admit("thread child", { surface: "thread_launch" });
      if (admission._tag !== "admitted") return yield* Effect.die("expected admission");
      yield* childWork.markLaunched(admission.record, { threadId: childThread });
      const stopEventId = taskEventIdFor(taskId, 99);
      const outcome = yield* childWork.cancelForTask({
        taskId,
        generation: 1,
        stopEventId,
        attempt: 0,
        reason: "Stopped.",
      });
      assert.strictEqual(outcome, "settled");
      const ledger = yield* ChannelLedger.ChannelLedger;
      assert.strictEqual(yield* ledger.stopAttempt(stopEventId), 0);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual(
        (yield* store.get(taskId, admission.record.childWorkId))?.state,
        "cancelled",
      );
    }).pipe(
      Effect.provide(
        makeLayer(
          new Map([[childThread, [fakeRun("cancelled")]]]),
          new Map([[childThread, { _tag: "OrchestratorCommandRejectedError" }]]),
          dispatched,
        ),
      ),
    );
  });

  it.effect("keeps retrying a refused child stop while a cloud task keeps the thread live", () => {
    const dispatched: Array<DispatchedStop> = [];
    return Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const admission = yield* admit("thread child", { surface: "thread_launch" });
      if (admission._tag !== "admitted") return yield* Effect.die("expected admission");
      yield* childWork.markLaunched(admission.record, { threadId: childThread });
      const stopEventId = taskEventIdFor(taskId, 99);
      const outcome = yield* childWork.cancelForTask({
        taskId,
        generation: 1,
        stopEventId,
        attempt: 0,
        reason: "Stopped.",
      });
      assert.strictEqual(outcome, "retry");
      const ledger = yield* ChannelLedger.ChannelLedger;
      assert.strictEqual(yield* ledger.stopAttempt(stopEventId), 1);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual(
        (yield* store.get(taskId, admission.record.childWorkId))?.state,
        "launched",
      );
    }).pipe(
      Effect.provide(
        makeLayer(
          new Map([[childThread, [fakeRun("cancelled")]]]),
          new Map([[childThread, { _tag: "OrchestratorCommandRejectedError" }]]),
          dispatched,
          new Map([
            [
              childThread,
              [
                {
                  id: "pt-1",
                  providerInstanceId: "pi-1",
                  cloudTask: { status: "running" },
                  pendingBackgroundTasks: [],
                },
              ],
            ],
          ]),
        ),
      ),
    );
  });

  it.effect("keeps the stop pending when a child stop dispatch fails transiently", () => {
    const dispatched: Array<DispatchedStop> = [];
    return Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const admission = yield* admit("thread child", { surface: "thread_launch" });
      if (admission._tag !== "admitted") return yield* Effect.die("expected admission");
      yield* childWork.markLaunched(admission.record, { threadId: childThread });
      const stopEventId = taskEventIdFor(taskId, 99);
      const outcome = yield* childWork.cancelForTask({
        taskId,
        generation: 1,
        stopEventId,
        attempt: 0,
        reason: "Stopped.",
      });
      assert.strictEqual(outcome, "retry");
      const ledger = yield* ChannelLedger.ChannelLedger;
      assert.strictEqual(yield* ledger.stopAttempt(stopEventId), 0);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual(
        (yield* store.get(taskId, admission.record.childWorkId))?.state,
        "launched",
      );
    }).pipe(
      Effect.provide(
        makeLayer(
          new Map([[childThread, [fakeRun("running")]]]),
          new Map([[childThread, new Error("connection reset")]]),
          dispatched,
        ),
      ),
    );
  });
});
