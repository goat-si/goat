import { staleSettlementAndItemStatuses } from "./OrchestratorSettlement.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import {
  orchestrationCommandDuration,
  orchestrationCommandsTotal,
} from "../observability/Metrics.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadArchiveGate from "./ThreadArchiveGate.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect(
  "records approval feedback and targets only its runtime request without dispatching a parent turn",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:approval-feedback");
      const sessionId = ProviderSessionId.make("session:approval-feedback");
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-approval-feedback"),
        threadId,
        projectId: ProjectId.make("project:approval-feedback"),
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* projections.apply({
        id: EventId.make("session:approval-feedback"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      for (const name of ["child", "other"]) {
        yield* projections.apply({
          id: EventId.make(`request:${name}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make(name),
            nodeId: NodeId.make(`node:${name}`),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "command",
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: sessionId,
              supportsFeedback: name === "child",
            },
            createdAt: now,
            resolvedAt: null,
          },
        });
      }
      const commandId = CommandId.make("respond:approval-feedback");
      const feedback = "Run it in a safer manner.";
      for (const [index, invalid] of [
        { requestId: RuntimeRequestId.make("other"), decision: "decline" as const, feedback },
        { requestId: RuntimeRequestId.make("child"), decision: "accept" as const, feedback },
        { requestId: RuntimeRequestId.make("child"), decision: "decline" as const, feedback: "  " },
      ].entries()) {
        const rejectedId = CommandId.make(`invalid-feedback:${index}`);
        const rejected = yield* orchestrator
          .dispatch({
            type: "runtime-request.respond",
            commandId: rejectedId,
            threadId,
            ...invalid,
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(rejected));
        assert.deepEqual(yield* outbox.listByCommandId(rejectedId), []);
      }
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId,
        threadId,
        requestId: RuntimeRequestId.make("child"),
        decision: "decline",
        feedback,
      });
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(
        projection.runtimeRequests.find((request) => request.id === "child")?.feedback,
        feedback,
      );
      assert.equal(
        projection.runtimeRequests.find((request) => request.id === "other")?.status,
        "pending",
      );
      assert.equal(projection.messages.at(-1)?.text, feedback);
      const feedbackMessageId = MessageId.make("approval-feedback:child");
      assert.ok(
        projection.visibleTurnItems.some(
          ({ item }) =>
            item.type === "user_message" &&
            item.messageId === feedbackMessageId &&
            item.text === feedback,
        ),
      );
      const history = yield* projections.getTimelinePage(threadId, { limit: 20, view: "messages" });
      assert.ok(
        history.items.some(
          ({ item }) =>
            item.type === "user_message" &&
            item.messageId === feedbackMessageId &&
            item.text === feedback,
        ),
      );
      assert.equal(projection.runs.length, 0);
      assert.deepEqual(
        (yield* outbox.listByCommandId(commandId)).map((effect) => effect.request),
        [
          {
            type: "runtime-request.respond",
            providerSessionId: sessionId,
            requestId: RuntimeRequestId.make("child"),
            decision: "decline",
            feedback,
          },
        ],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("marks a never-visited thread's first completion unread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:completion-watermark");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-completion-watermark"),
      threadId,
      projectId: ProjectId.make("project:completion-watermark"),
      title: "Background task",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    assert.isNull((yield* projections.getThreadShell(threadId))?.lastVisitedAt);
    const dispatch = (id: string) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId,
        messageId: MessageId.make(id),
        text: "Run in the background",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "agent",
        creationSource: "mcp",
      });
    yield* TestClock.adjust("1 second");
    const dispatchedAt = yield* DateTime.now;
    yield* dispatch("first-completion-watermark");
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("interrupt-completion-watermark"),
      threadId,
      runId: (yield* projections.getThreadProjection(threadId)).runs[0]!.id,
    });
    // The run ends in the dispatch's millisecond and must still be unread.
    const ended = yield* projections.getThreadShell(threadId);
    assert.ok(ended?.lastVisitedAt && ended.latestRunCompletedAt);
    assert.equal(
      DateTime.toEpochMillis(ended.lastVisitedAt),
      DateTime.toEpochMillis(dispatchedAt) - 1,
    );
    assert.isAbove(
      DateTime.toEpochMillis(ended.latestRunCompletedAt),
      DateTime.toEpochMillis(ended.lastVisitedAt),
    );

    yield* TestClock.adjust("1 second");
    yield* dispatch("second-completion-watermark");
    assert.deepEqual(
      (yield* projections.getThreadShell(threadId))?.lastVisitedAt,
      ended.lastVisitedAt,
    );
  }).pipe(Effect.provide(layerTest)),
);

const completeAndSnoozeThread = Effect.fn("test.completeAndSnoozeThread")(function* (
  name: string,
  snoozeMinutes: number,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create-${name}`),
    threadId,
    projectId: ProjectId.make(`project:${name}`),
    title: "Snoozed completion",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`dispatch-${name}`),
    threadId,
    messageId: MessageId.make(`dispatch-${name}`),
    text: "Run in the background",
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "agent",
    creationSource: "mcp",
  });
  yield* orchestrator.dispatch({
    type: "run.interrupt",
    commandId: CommandId.make(`interrupt-${name}`),
    threadId,
    runId: (yield* projections.getThreadProjection(threadId)).runs[0]!.id,
  });
  const completedAt = (yield* projections.getThreadProjection(threadId)).runs.at(-1)?.completedAt;
  assert.ok(completedAt);
  yield* TestClock.adjust("1 second");
  const snoozedUntil = DateTime.add(yield* DateTime.now, { minutes: snoozeMinutes });
  yield* orchestrator.dispatch({
    type: "thread.snooze",
    commandId: CommandId.make(`snooze-${name}`),
    threadId,
    snoozedUntil: DateTime.formatIso(snoozedUntil),
  });
  return { threadId, completedAt, snoozedUntil };
});

it.effect("mark unread retires an expired snooze so a dismissed wake stays dismissed", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId, completedAt, snoozedUntil } = yield* completeAndSnoozeThread(
      "mark-unread-expired-snooze",
      1,
    );
    yield* TestClock.adjust("2 minutes");
    yield* orchestrator.dispatch({
      type: "thread.visit",
      commandId: CommandId.make("dismiss-woke"),
      threadId,
      visitedAt: DateTime.formatIso(snoozedUntil),
    });
    const dismissed = yield* projections.getThread(threadId);
    assert.deepEqual(dismissed.lastVisitedAt, snoozedUntil);

    yield* orchestrator.dispatch({
      type: "thread.mark-unread",
      commandId: CommandId.make("mark-unread-expired-snooze"),
      threadId,
    });
    assert.deepEqual(yield* projections.getThread(threadId), {
      ...dismissed,
      lastVisitedAt: DateTime.subtract(completedAt, { milliseconds: 1 }),
      markedUnreadCompletionAt: completedAt,
      snoozedUntil: null,
      snoozedAt: null,
      lastSnoozeWakeAt: snoozedUntil,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("mark unread leaves a future snooze untouched", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId, completedAt } = yield* completeAndSnoozeThread(
      "mark-unread-future-snooze",
      60,
    );
    yield* TestClock.adjust("1 minute");
    yield* orchestrator.dispatch({
      type: "thread.visit",
      commandId: CommandId.make("visit-snoozed"),
      threadId,
      visitedAt: DateTime.formatIso(yield* DateTime.now),
    });
    const visited = yield* projections.getThread(threadId);
    assert.isNotNull(visited.snoozedUntil);

    yield* orchestrator.dispatch({
      type: "thread.mark-unread",
      commandId: CommandId.make("mark-unread-future-snooze"),
      threadId,
    });
    assert.deepEqual(yield* projections.getThread(threadId), {
      ...visited,
      lastVisitedAt: DateTime.subtract(completedAt, { milliseconds: 1 }),
      markedUnreadCompletionAt: completedAt,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "dispatches metadata, queue resume and request controls without hydrating unrelated history",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:control-dispatch");
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-control"),
        threadId,
        projectId: ProjectId.make("project:control-dispatch"),
        title: "Before",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const enabled of [false, true]) {
        yield* orchestrator.dispatch({
          type: "thread.auto-settle.set",
          commandId: CommandId.make(`auto-settle-${enabled}`),
          threadId,
          enabled,
        });
        const updated = yield* projections.getThreadProjection(threadId);
        assert.equal(updated.thread.autoSettleDisabledAt == null, enabled);
        const shell = yield* projections.getThreadShell(threadId);
        assert.ok(shell);
        assert.equal(shell.autoSettleDisabledAt == null, enabled);
      }
      yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('obsolete', ${threadId}, NULL, NULL, 'assistant', 0, ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      assert.equal((yield* Effect.exit(projections.getThreadProjection(threadId)))._tag, "Failure");
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-empty-queue"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename-control"),
        threadId,
        title: "After",
      });
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("mode-control"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("model-control"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-6" },
      });
      const sessionId = ProviderSessionId.make("session:control-dispatch");
      yield* projections.apply({
        id: EventId.make("attach-control"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: "gpt-6",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      for (const mode of ["live", "message"] as const) {
        const requestId = RuntimeRequestId.make(`request:${mode}`);
        yield* projections.apply({
          id: EventId.make(`request:${mode}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: NodeId.make(`node:${mode}`),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability:
              mode === "live"
                ? { type: "live", providerSessionId: sessionId }
                : { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
        const nodeId = NodeId.make(`node:${mode}`);
        yield* projections.apply({
          id: EventId.make(`node:${mode}`),
          type: "node.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`item:${mode}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${mode}`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: mode === "live" ? 1 : 2,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId,
            questions: [],
          },
        });
        const answers = { text: "Blue", list: ["Red"], codex: { answers: ["Green"] } };
        const normalizedAnswers = { ...answers, codex: ["Green"] };
        if (mode === "live") {
          const pending = yield* projections.getRuntimeResponseContext(threadId, requestId);
          const sequence = yield* orchestrator.getThreadEventSequence(threadId);
          for (const [index, value] of [
            null,
            42,
            { choice: "Blue" },
            ["Blue", 42],
            { answers: [42] },
          ].entries()) {
            const commandId = CommandId.make(`invalid-answer:${index}`);
            const result = yield* orchestrator
              .dispatch({
                type: "runtime-request.respond",
                commandId,
                threadId,
                requestId,
                answers: { ...answers, invalid: value },
              })
              .pipe(Effect.result);
            assert.isTrue(Result.isFailure(result));
            assert.deepEqual(
              yield* projections.getRuntimeResponseContext(threadId, requestId),
              pending,
            );
            assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
            assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
          }
        }
        yield* orchestrator.dispatch(
          mode === "live"
            ? {
                type: "runtime-request.respond",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
                answers,
              }
            : {
                type: "thread.user-input.dismiss",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
              },
        );
        assert.equal(
          (yield* projections.getRuntimeRequest(threadId, requestId))?.status,
          "resolved",
        );
        const response = yield* projections.getRuntimeResponseContext(threadId, requestId);
        assert.equal(response.node?.status, mode === "live" ? "completed" : "cancelled");
        assert.equal(response.item?.status, mode === "live" ? "completed" : "cancelled");
        if (mode === "live") {
          assert.deepEqual(response.request?.answers, normalizedAnswers);
          assert.equal(response.item?.type, "user_input_request");
          if (response.item?.type === "user_input_request") {
            assert.deepEqual(response.item.questionAnswer?.answers, normalizedAnswers);
          }
          const effects = yield* outbox.listByCommandId(CommandId.make(`respond:${mode}`));
          assert.deepEqual(
            effects.map((effect) => effect.request),
            [
              {
                type: "runtime-request.respond",
                providerSessionId: sessionId,
                requestId,
                answers: normalizedAnswers,
              },
            ],
          );
        }
      }
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("workspace-control"),
        threadId,
        worktreePath: "/new-repo",
      });
      const thread = yield* projections.getThread(threadId);
      assert.equal(thread.title, "After");
      assert.equal(thread.modelSelection.model, "gpt-6");
      assert.equal(thread.runtimeMode, "approval-required");
      assert.deepEqual(
        (yield* projections.getThreadProviderContext(threadId)).providerSessions,
        [],
      );
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          type, status, ordinal, updated_at, payload_json)
        VALUES ('obsolete-output', ${threadId}, NULL, NULL, NULL, NULL,
          'command_execution', 'completed', 900, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id, thread_id, run_id, node_id, kind, status, payload_json)
        VALUES ('obsolete-plan', ${threadId}, NULL, 'old-node', 'proposed', 'completed', '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_handoffs
        (context_handoff_id, thread_id, target_run_id, to_provider_thread_id, strategy, status, updated_at, payload_json)
        VALUES ('obsolete-handoff', ${threadId}, 'old-run', 'old-provider-thread', 'full_thread_summary', 'ready', ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("dispatch-with-old-history"),
        threadId,
        messageId: MessageId.make("fresh-input"),
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const fresh = yield* projections.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["user_message"],
      });
      assert.isAbove(fresh.turnItems.at(-1)!.ordinal, 900);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-with-old-history"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-with-old-history"),
        threadId,
      });
      assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps the store's read failure as the cause when a command projection fails", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    const now = DateTime.formatIso(yield* DateTime.now);
    const unreadableMessage = ThreadId.make("thread:control-unreadable-message");
    const unreadableRequest = ThreadId.make("thread:control-unreadable-request");
    for (const threadId of [unreadableMessage, unreadableRequest]) {
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:control-unreadable"),
        title: "Unreadable",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }
    yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('obsolete-user', ${unreadableMessage}, NULL, NULL, 'user', 0, ${now}, ${now}, '{"obsolete":true}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
      (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      VALUES ('request:unreadable', ${unreadableRequest}, 'node:unreadable', 'user-input', 'pending', ${now}, '{}')`;
    for (const command of [
      {
        type: "queue.resume",
        commandId: CommandId.make("resume-unreadable"),
        threadId: unreadableMessage,
      },
      {
        type: "thread.user-input.dismiss",
        commandId: CommandId.make("dismiss-unreadable"),
        threadId: unreadableRequest,
        requestId: RuntimeRequestId.make("request:unreadable"),
      },
    ] as const) {
      const failure = yield* orchestrator.dispatch(command).pipe(Effect.flip);
      assert.instanceOf(failure, Orchestrator.OrchestratorProjectionError);
      assert.instanceOf(failure.cause, ProjectionStore.ProjectionStoreReadError);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("implements a proposed plan that the command projection leaves out", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:implement-plan");
    const planId = PlanId.make("plan:implement-plan");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-implement-plan"),
      threadId,
      projectId: ProjectId.make("project:implement-plan"),
      title: "Plan",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("plan:implement-plan"),
      type: "plan.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: planId,
        threadId,
        runId: null,
        nodeId: NodeId.make("node:implement-plan"),
        kind: "proposed_plan",
        status: "active",
        markdown: "# Plan\n\n1. Do the thing.",
      },
    });

    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("implement-plan"),
      threadId,
      messageId: MessageId.make("implement-plan-input"),
      text: "Implement the plan.",
      attachments: [],
      sourcePlanRef: { threadId, planId },
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });

    assert.equal((yield* projections.getPlan(threadId, planId))?.status, "completed");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("settles only the stopped run's background work, once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:settle-binding");
    const providerThreadId = ProviderThreadId.make("provider-thread:settle-binding");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-settle-binding"),
      threadId,
      projectId: ProjectId.make("project:settle-binding"),
      title: "Settle binding",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("settle-binding:provider-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    const commandItem = (ordinal: number) => TurnItemId.make(`turn-item:settle-binding:${ordinal}`);
    for (const ordinal of [1, 2]) {
      const runId = RunId.make(`run:settle-binding:${ordinal}`);
      const attemptId = RunAttemptId.make(`attempt:settle-binding:${ordinal}`);
      const nodeId = NodeId.make(`node:settle-binding:${ordinal}`);
      const providerTurnId = ProviderTurnId.make(`provider-turn:settle-binding:${ordinal}`);
      yield* projections.apply({
        id: EventId.make(`settle-binding:run:${ordinal}`),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message:settle-binding:${ordinal}`),
          rootNodeId: nodeId,
          activeAttemptId: attemptId,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:attempt:${ordinal}`),
        type: "run-attempt.created",
        threadId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: instanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:turn:${ordinal}`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:item:${ordinal}`),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: commandItem(ordinal),
          threadId,
          runId,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal * 10,
          status: "running",
          title: `Background command ${ordinal}`,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: `sleep ${ordinal}`,
        },
      });
    }
    const itemStatuses = yield* staleSettlementAndItemStatuses(orchestrator, projections, threadId);
    const settle = {
      type: "thread.background-work.settle",
      commandId: CommandId.make("stop-run-1:background-work-settled"),
      threadId,
      providerThreadId,
      providerTurnId: ProviderTurnId.make("provider-turn:settle-binding:1"),
    } as const;
    yield* orchestrator.dispatch(settle);
    assert.deepEqual(yield* itemStatuses, [
      `${commandItem(1)}:interrupted`,
      `${commandItem(2)}:running`,
    ]);

    const emptySettle = {
      ...settle,
      commandId: CommandId.make("stop-run-1-again:background-work-settled"),
    };
    const first = yield* orchestrator.dispatch(emptySettle);
    assert.lengthOf(first.storedEvents, 0);
    yield* projections.apply({
      id: EventId.make("settle-binding:item:late"),
      type: "turn-item.updated",
      threadId,
      runId: RunId.make("run:settle-binding:1"),
      occurredAt: now,
      payload: {
        id: commandItem(3),
        threadId,
        runId: RunId.make("run:settle-binding:1"),
        nodeId: NodeId.make("node:settle-binding:1"),
        providerThreadId,
        providerTurnId: ProviderTurnId.make("provider-turn:settle-binding:1"),
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 30,
        status: "running",
        title: "Late background command",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution",
        input: "sleep 3",
      },
    });
    const replayed = yield* orchestrator.dispatch(emptySettle);
    assert.lengthOf(replayed.storedEvents, 0);
    assert.deepEqual(yield* itemStatuses, [
      `${commandItem(1)}:interrupted`,
      `${commandItem(2)}:running`,
      `${commandItem(3)}:running`,
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps delegated child pull-request links independent of the parent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentThreadId = ThreadId.make("thread:parent-pr");
    const projectId = ProjectId.make("project:parent-pr");
    const parentPullRequest = {
      projectId,
      repository: "goat-si/goat",
      number: 123,
      url: "https://github.com/goat-si/goat/pull/123",
    };
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-parent-pr"),
      threadId: parentThreadId,
      projectId,
      title: "Parent with a linked PR",
      launchedBy: {
        kind: "launch" as const,
        environmentLabel: null,
        threadTitle: null,
        threadId: ThreadId.make("grandparent"),
        environmentId: null,
        via: "thread_launch",
      },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/parent-pr",
      worktreePath: "/repo-worktree",
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-parent-pr"),
      threadId: parentThreadId,
      linkedPullRequest: parentPullRequest,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-parent-pr"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:parent-pr"),
      text: "Delegate a review",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parent = yield* projections.getThreadProjection(parentThreadId);
    const parentRun = parent.runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-parent-pr"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Review the changes",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const updatedParent = yield* projections.getThreadProjection(parentThreadId);
    const childThreadId = updatedParent.subagents[0]!.childThreadId!;
    const child = yield* projections.getThreadProjection(childThreadId);
    assert.deepEqual(child.thread.launchedBy, {
      kind: "launch" as const,
      environmentLabel: null,
      threadTitle: "Parent with a linked PR",
      threadId: parentThreadId,
      environmentId: null,
      via: "delegate_task",
    });
    const replay = yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-parent-pr"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Review the changes",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    assert.equal(
      replay.storedEvents.find((event) => event.event.type === "thread.created")?.event.threadId,
      childThreadId,
    );
    assert.lengthOf((yield* projections.getThreadProjection(parentThreadId)).subagents, 1);
    assert.isNull(child.thread.linkedPullRequest);
    assert.deepEqual(child.thread.pullRequests, []);
    assert.equal(child.thread.branch, parent.thread.branch);
    assert.equal(child.thread.worktreePath, parent.thread.worktreePath);
    assert.equal(child.thread.lineage.parentThreadId, parentThreadId);

    const childPullRequest = {
      ...parentPullRequest,
      number: 456,
      url: "https://github.com/goat-si/goat/pull/456",
    };
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-child-pr"),
      threadId: childThreadId,
      linkedPullRequest: childPullRequest,
    });
    const linkedChild = yield* projections.getThreadProjection(childThreadId);
    assert.deepEqual(linkedChild.thread.linkedPullRequest, childPullRequest);
    assert.deepEqual(
      linkedChild.thread.pullRequests?.map((link) => link.number),
      [456],
    );
    const parentAfterChildLink = yield* projections.getThreadProjection(parentThreadId);
    assert.deepEqual(parentAfterChildLink.thread.linkedPullRequest, parentPullRequest);
    assert.deepEqual(parentAfterChildLink.thread.pullRequests, parent.thread.pullRequests);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([false, true])("rejects thread.create for an existing id (deleted: %s)", (deleted) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:duplicate-create:${deleted}`);
    const create = {
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:duplicate-create"),
      title: "Original",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      importedNativeThread: {
        ref: { driver: adapter.driver, nativeId: "native-original", strength: "strong" },
      },
    } as const;
    yield* orchestrator.dispatch(create);
    if (deleted) {
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`delete:${threadId}`),
        threadId,
      });
    }
    const before = yield* projections.getThread(threadId);
    assert.isNotNull(before.activeProviderThreadId);
    assert.equal(before.deletedAt !== null, deleted);
    const sequence = yield* orchestrator.getThreadEventSequence(threadId);
    yield* TestClock.adjust("1 second");
    const duplicate = {
      ...create,
      commandId: CommandId.make(`duplicate:${threadId}`),
      title: "Replacement",
      importedNativeThread: undefined,
    };
    const outcome = yield* orchestrator.dispatch(duplicate).pipe(Effect.result);
    assert.ok(Result.isFailure(outcome), "duplicate create must be rejected");
    const refused = outcome.failure;
    assert.equal(refused._tag, "OrchestratorThreadAlreadyExistsError");
    assert.equal(refused.message, `Thread ${threadId} already exists. Use a new thread id.`);
    assert.deepEqual(yield* projections.getThread(threadId), before);
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
    const retried = yield* orchestrator.dispatch(duplicate).pipe(Effect.flip);
    assert.equal(retried._tag, "OrchestratorCommandPreviouslyRejectedError");
    assert.include(retried.message, refused.message);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("replays a thread.create receipt without changing the thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:create-receipt-replay");
    const create = {
      type: "thread.create",
      commandId: CommandId.make("create:receipt-replay"),
      threadId,
      projectId: ProjectId.make("project:duplicate-create"),
      title: "Original",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    } as const;
    const original = yield* orchestrator.dispatch(create);
    const before = yield* projections.getThread(threadId);
    const replayed = yield* orchestrator.dispatch(create);
    assert.equal(replayed.sequence, original.sequence);
    // Marked so client analytics do not count the retry again.
    assert.deepEqual(replayed, { ...original, replayed: true });
    assert.deepEqual(yield* projections.getThread(threadId), before);
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId), original.sequence);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("explicit settle clears snooze atomically and stays idempotent after re-snoozing", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("thread:settle-snoozed");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-settle-snoozed"),
      threadId,
      projectId: ProjectId.make("project:settle-snoozed"),
      title: "Snoozed thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    const settledAt = DateTime.add(now, { seconds: 1 });
    const snoozedUntil = DateTime.add(now, { hours: 1 });
    for (const round of [1, 2]) {
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make(`snooze-before-settle-${round}`),
        threadId,
        snoozedUntil: DateTime.formatIso(snoozedUntil),
      });
      assert.deepInclude(yield* projections.getThread(threadId), {
        snoozedUntil,
        snoozedAt: yield* DateTime.now,
      });
      yield* TestClock.adjust("1 second");
      const commandId = CommandId.make(`settle-snoozed-${round}`);
      yield* orchestrator.dispatch({ type: "thread.settle", commandId, threadId });
      const expected = {
        settledOverride: "settled",
        settledAt,
        snoozedUntil: null,
        snoozedAt: null,
        updatedAt: yield* DateTime.now,
      } as const;
      const committed = yield* events.readByCommandId({ commandId }).pipe(Stream.runCollect);
      assert.lengthOf(committed, 1);
      assert.equal(committed[0]?.event.type, "thread.settled");
      assert.deepInclude(committed[0]?.event.payload, expected);
      const settled = yield* projections.getThreadShell(threadId);
      assert.deepInclude(settled, expected);
      assert.deepInclude((yield* projections.getThreadProjection(threadId)).thread, expected);

      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`settle-again-${round}`),
        threadId,
      });
      assert.deepEqual(yield* projections.getThreadShell(threadId), settled);
    }
    yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make("unsettle-after-snooze"),
      threadId,
      reason: "user",
    });
    const active = {
      settledOverride: "active",
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
    } as const;
    assert.deepInclude(yield* projections.getThreadShell(threadId), active);
    assert.deepInclude((yield* projections.getThreadProjection(threadId)).thread, active);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("dispatch records the command outcome and its duration", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const successes = Metric.value(
      Metric.withAttributes(orchestrationCommandsTotal, {
        commandType: "thread.create",
        outcome: "success",
      }),
    );
    const durations = Metric.value(
      Metric.withAttributes(orchestrationCommandDuration, { commandType: "thread.create" }),
    );
    const successesBefore = (yield* successes).count;
    const durationsBefore = (yield* durations).count;

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-dispatch-metrics"),
      threadId: ThreadId.make("thread:dispatch-metrics"),
      projectId: ProjectId.make("project:dispatch-metrics"),
      title: "Dispatch metrics",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });

    assert.strictEqual((yield* successes).count - successesBefore, 1);
    assert.strictEqual((yield* durations).count - durationsBefore, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("records a thread's history archive state without making it look active", () => {
  const slot = ThreadArchiveGate.makeThreadArchiveGateSlot();
  const restored: string[] = [];
  slot.install((threadId) => Effect.sync(() => restored.push(threadId)));
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:history-archive-state");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-history-archive-state"),
      threadId,
      projectId: ProjectId.make("project:history-archive-state"),
      title: "Old work",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const created = yield* projections.getThreadShell(threadId);
    assert.isDefined(created?.updatedAt);
    yield* TestClock.adjust("40 days");
    restored.length = 0;
    for (const [index, state] of (["archived", null, "deleted"] as const).entries()) {
      // Recording the state reads the thread; that read must not restore the history.
      yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`history-archive-state-${index}`),
          threadId,
          historyArchive: state,
        })
        .pipe(Effect.provideService(ThreadArchiveGate.SkipThreadArchiveRestore, true));
      const shell = yield* projections.getThreadShell(threadId);
      assert.equal(shell?.historyArchive, state ?? undefined);
      assert.deepEqual(shell?.updatedAt, created?.updatedAt);
    }
    assert.deepEqual(restored, []);
    // Any other read of the thread restores first.
    yield* projections.getThread(threadId);
    assert.deepEqual(restored, [threadId]);
  }).pipe(
    Effect.provide(
      layerTest.pipe(Layer.provide(Layer.succeed(ThreadArchiveGate.ThreadArchiveGate, slot))),
    ),
  );
});
