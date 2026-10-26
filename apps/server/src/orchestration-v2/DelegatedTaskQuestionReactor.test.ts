import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as AutomationHold from "../automationHold.ts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as DelegatedTaskQuestionReactor from "./DelegatedTaskQuestionReactor.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
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

it.effect("subscribes to delegated questions only after automation is released", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hold = yield* AutomationHold.makeInMemory({
        reason: "channel-copy",
        heldAt: "2026-10-25T00:00:00.000Z",
      });
      const subscribed = yield* Deferred.make<void>();
      const layer = DelegatedTaskQuestionReactor.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                Stream.drain,
                Stream.concat(Stream.never),
              ),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
        yield* reactor.start();
        yield* TestClock.adjust(0);
        assert.isFalse(yield* Deferred.isDone(subscribed));
        yield* hold.release;
        yield* Deferred.await(subscribed);
      }).pipe(Effect.provide(layer), Effect.provideService(AutomationHold.AutomationHold, hold));
    }),
  ),
);

it.effect("holds delegated question wakes until release, then wakes the parent once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
    const hold = yield* AutomationHold.AutomationHold;
    const parentThreadId = ThreadId.make("thread:question-parent");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-question-parent"),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:question"),
      title: "Parent",
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
      commandId: CommandId.make("start-question-parent"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:question-parent"),
      text: "Delegate the research",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parentRun = (yield* projections.getThreadProjection(parentThreadId)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-question-task"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Research the sources",
      completionWake: "settled_only",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const task = (yield* projections.getThreadProjection(parentThreadId)).subagents[0]!;
    const childRun = (yield* projections.getThreadRecords(task.childThreadId!, ["runs"])).runs[0]!;
    const now = yield* DateTime.now;
    const requestEvent = (
      eventId: string,
      requestId: string,
      responseCapability: "live" | "message" = "message",
      kind: "user_input" | "command" = "user_input",
      run = childRun,
    ) =>
      ({
        id: EventId.make(eventId),
        type: "runtime-request.updated",
        threadId: task.childThreadId!,
        runId: run.id,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make(requestId),
          nodeId: run.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind,
          status: "pending",
          responseCapability:
            responseCapability === "live"
              ? { type: "live", providerSessionId: ProviderSessionId.make("session:question") }
              : { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      }) satisfies OrchestrationV2DomainEvent;
    const question = requestEvent("event:question", "request:question", "live");
    const asyncQuestion = requestEvent("event:async-question", "request:async-question");
    const answered = requestEvent("event:answered", "request:answered", "live");
    const approval = requestEvent("event:approval", "request:approval", "message", "command");
    const eventSink = yield* EventSink.EventSinkV2;
    yield* eventSink.write({
      events: [question, asyncQuestion, answered, approval],
    });

    yield* reactor.handle(question);
    assert.isFalse(
      (yield* projections.getThreadProjection(parentThreadId)).messages.some(
        (message) => message.notification !== undefined,
      ),
    );
    yield* reactor.handle(asyncQuestion);
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
        (message) => message.notification !== undefined,
      ).length,
      0,
    );
    yield* hold.release;
    yield* reactor.handle(asyncQuestion);
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
        (message) => message.notification !== undefined,
      ).length,
      1,
    );
    yield* reactor.handle(asyncQuestion);
    yield* reactor.handle(answered);
    yield* eventSink.write({
      events: [
        {
          ...answered,
          id: EventId.make("event:answered-resolved"),
          payload: { ...answered.payload, status: "resolved", resolvedAt: now },
        },
      ],
    });
    yield* reactor.handle(answered);
    yield* reactor.handle(approval);

    const wakes = (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
      (message) => message.notification !== undefined,
    );
    assert.include(wakes[0]?.text, "asked a question and is still working");
    assert.deepEqual(
      wakes.map((message) => message.notification),
      [
        {
          source: {
            kind: "delegated_task",
            taskIds: [task.id],
            childThreadId: task.childThreadId!,
          },
          outcome: "updated",
          summary: 'Delegated task "Research the sources" has a question',
        },
      ],
    );

    const wakeRun = (yield* projections.getThreadRecords(parentThreadId, ["runs"])).runs.find(
      (run) => run.userMessageId === wakes[0]!.id,
    )!;
    assert.equal(wakeRun.status, "queued");
    const resolved = {
      ...asyncQuestion,
      id: EventId.make("event:question-resolved"),
      payload: { ...asyncQuestion.payload, status: "resolved" as const, resolvedAt: now },
    };
    yield* eventSink.write({ events: [resolved] });
    yield* reactor.handle(resolved);
    assert.equal(
      (yield* projections.getThreadRecords(parentThreadId, ["runs"])).runs.find(
        (run) => run.id === wakeRun.id,
      )?.status,
      "cancelled",
    );
    const parentCompleted = {
      id: EventId.make("event:question-parent-completed"),
      type: "run.updated",
      threadId: parentThreadId,
      runId: parentRun.id,
      occurredAt: now,
      payload: { ...parentRun, status: "completed", completedAt: now },
    } satisfies OrchestrationV2DomainEvent;
    for (const status of [
      "preparing",
      "starting",
      "running",
      "queued",
      "cancelled",
      "rolled_back",
      "interrupted",
    ] as const) {
      yield* reactor.handle({ ...parentCompleted, payload: { ...parentRun, status } });
    }
    assert.equal(
      (yield* projections.getThreadRecords(parentThreadId, ["messages"])).messages.length,
      2,
    );
    yield* eventSink.write({ events: [parentCompleted] });
    for (const state of ["disposed", "pending"] as const) {
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`event:question-task-${state}`),
            type: "subagent.updated",
            threadId: parentThreadId,
            occurredAt: now,
            payload: { ...task, completionDelivery: { state, observedByRunId: null } },
          },
        ],
      });
      yield* reactor.handle(parentCompleted);
      if (state === "disposed") {
        assert.equal(
          (yield* projections.getThreadRecords(parentThreadId, ["messages"])).messages.length,
          2,
        );
      }
    }
    yield* reactor.handle(parentCompleted);
    const caughtUp = (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
      (message) => message.notification !== undefined,
    );
    assert.equal(caughtUp.length, 2);
    assert.equal(
      caughtUp.filter((message) => message.text.includes(`requestId ${question.payload.id}.`))
        .length,
      1,
    );
    assert.include(caughtUp[1]?.text, "is blocked on a question");
    assert.isFalse(
      caughtUp.some((message) => message.text.includes(`requestId ${answered.payload.id}.`)),
    );
    yield* reactor.handle(question);
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
        (message) => message.notification !== undefined,
      ).length,
      2,
    );
    const terminalQuestion = requestEvent(
      "event:terminal-question",
      "request:terminal-question",
      "live",
    );
    yield* eventSink.write({ events: [terminalQuestion] });
    yield* reactor.handle(terminalQuestion);
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
        (message) => message.notification !== undefined,
      ).length,
      3,
    );
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:question-parent-running-again"),
          type: "run.updated",
          threadId: parentThreadId,
          runId: parentRun.id,
          occurredAt: now,
          payload: { ...parentRun, status: "running", completedAt: null },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "delegated_task.wake-policy",
      commandId: CommandId.make("terminal-question-wait-ended"),
      parentThreadId,
      taskId: task.id,
      completionWake: "always",
    });
    const upgradedQuestion = requestEvent(
      "event:upgraded-question",
      "request:upgraded-question",
      "live",
    );
    yield* eventSink.write({ events: [upgradedQuestion] });
    yield* reactor.handle(upgradedQuestion);
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
        (message) => message.notification !== undefined,
      ).length,
      4,
    );
    const waitDelivered = requestEvent("event:wait-delivered", "request:wait-delivered", "live");
    const waitDeliveredParentCompleted = {
      ...parentCompleted,
      id: EventId.make("event:wait-delivered-parent-completed"),
    };
    yield* eventSink.write({ events: [waitDelivered, waitDeliveredParentCompleted] });
    yield* reactor.handle(waitDeliveredParentCompleted);
    assert.isFalse(
      (yield* projections.getThreadProjection(parentThreadId)).messages.some((message) =>
        message.text.includes(`requestId ${waitDelivered.payload.id}.`),
      ),
    );
    yield* eventSink.write({
      commandId: CommandId.make("command:runtime-reconcile:question-followup"),
      events: [
        {
          id: EventId.make("event:question-child-completed"),
          type: "run.updated",
          threadId: task.childThreadId!,
          occurredAt: now,
          payload: { ...childRun, status: "completed", completedAt: now },
        },
        {
          id: EventId.make("event:question-task-completed"),
          type: "subagent.updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: {
            ...task,
            status: "completed",
            result: "Sources researched.",
            completedAt: now,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("question-followup"),
      threadId: task.childThreadId!,
      messageId: MessageId.make("message:question-followup"),
      text: "Check the sources again",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const followup = (yield* projections.getThreadRecords(task.childThreadId!, ["runs"])).runs.find(
      (run) => run.userMessageId === "message:question-followup",
    )!;
    assert.isDefined(followup.delegatedTaskId);
    assert.notEqual(followup.delegatedTaskId, task.id);
    const followupQuestion = requestEvent(
      "event:followup-question",
      "request:followup-question",
      "live",
      "user_input",
      followup,
    );
    yield* eventSink.write({ events: [followupQuestion] });
    yield* reactor.handle(followupQuestion);
    const followupWake = (yield* projections.getThreadRecords(parentThreadId, [
      "messages",
    ])).messages.find((message) =>
      message.text.includes(`requestId ${followupQuestion.payload.id}`),
    )!;
    assert.deepEqual(followupWake.notification?.source, {
      kind: "delegated_task",
      taskIds: [followup.delegatedTaskId],
      childThreadId: task.childThreadId!,
    });
  }).pipe(
    Effect.provide(
      DelegatedTaskQuestionReactor.layer.pipe(
        Layer.provideMerge(layerTest),
        Layer.provideMerge(
          Layer.effect(
            AutomationHold.AutomationHold,
            AutomationHold.makeInMemory({
              reason: "channel-copy",
              heldAt: "2026-10-25T00:00:00.000Z",
            }),
          ),
        ),
      ),
    ),
  ),
);
