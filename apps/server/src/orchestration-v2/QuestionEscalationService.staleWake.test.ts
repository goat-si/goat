import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as QuestionEscalationService from "./QuestionEscalationService.ts";
import {
  answer,
  holdLauncher,
  ids,
  instanceId,
  layerTest,
  records,
  seed,
  setup,
} from "./QuestionEscalationService.testkit.ts";

it.layer(layerTest)("QuestionEscalationService", (it) => {
  it.effect(
    "a queued wake for a question closed while nobody listened is dropped, and the question refuses an answer",
    () =>
      Effect.gen(function* () {
        const suffix = "stale-wake";
        const engine = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* setup(suffix);
        yield* holdLauncher(suffix);
        // Not started: the reconciler misses the closing event, as across a restart.
        yield* seed(suffix);
        const wake = (yield* records(suffix)).runs.find(
          (r) => r.userMessageId === ids(suffix).messageId,
        )!;
        assert.equal(wake.status, "queued");
        yield* answer(suffix, { type: "user" }, true);
        const hold = (yield* records(suffix)).runs.find(
          (r) => r.userMessageId === MessageId.make(`hold:${suffix}`),
        )!;
        const now = yield* DateTime.now;
        yield* projections.apply({
          id: EventId.make(`hold-finished:${suffix}`),
          type: "run.updated",
          threadId: hold.threadId,
          runId: hold.id,
          occurredAt: now,
          payload: { ...hold, status: "completed", completedAt: now },
        });
        yield* engine.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`resume:${suffix}`),
          threadId: ids(suffix).launcherId,
        });
        const after = yield* records(suffix);
        assert.equal(after.runs.find((r) => r.id === wake.id)?.status, "cancelled");
        assert.notEqual(
          after.runs.find((r) => r.userMessageId === MessageId.make(`unrelated:${suffix}`))?.status,
          "queued",
        );

        const refused = yield* answer(suffix, { type: "user" }, false).pipe(Effect.flip);
        assert.include(refused.message, "so it can no longer be answered.");
      }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
  it.effect.each(["completed", "failed"] as const)(
    "a %s task's pending question keeps its inbox item and wake, and answering it continues the child",
    (ending) =>
      Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sink = yield* EventSink.EventSinkV2;
        const service = yield* QuestionEscalationService.QuestionEscalationService;
        const parentThreadId = ThreadId.make(`thread:${ending}-task-parent`);
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${ending}-task-parent`),
          threadId: parentThreadId,
          projectId: ProjectId.make("project:question-escalation"),
          title: "Parent",
          modelSelection: { instanceId, model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`start:${ending}-task-parent`),
          messageId: MessageId.make(`message:${ending}-task-parent`),
          threadId: parentThreadId,
          text: "Delegate the proof",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const parentRun = (yield* projections.getThreadRecords(parentThreadId, ["runs"])).runs[0]!;
        yield* engine.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make(`delegate:${ending}-task`),
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Capture the proof",
          completionWake: "settled_only",
          modelSelection: { instanceId, model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "agent",
          creationSource: "mcp",
        });
        const task = (yield* projections.getThreadRecords(parentThreadId, ["subagents"]))
          .subagents[0]!;
        const childThreadId = task.childThreadId!;
        const childRun = (yield* projections.getThreadRecords(childThreadId, ["runs"])).runs[0]!;
        const now = yield* DateTime.now;
        const requestId = RuntimeRequestId.make(`request:${ending}-task`);
        const nodeId = NodeId.make(`node:${ending}-task-question`);
        const stored = yield* sink.write({
          events: [
            {
              id: EventId.make(`${ending}-task:node`),
              type: "node.updated",
              threadId: childThreadId,
              runId: childRun.id,
              nodeId,
              occurredAt: now,
              payload: {
                id: nodeId,
                threadId: childThreadId,
                runId: childRun.id,
                parentNodeId: childRun.rootNodeId,
                rootNodeId: childRun.rootNodeId ?? nodeId,
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
            },
            {
              id: EventId.make(`${ending}-task:request`),
              type: "runtime-request.updated",
              threadId: childThreadId,
              runId: childRun.id,
              nodeId,
              occurredAt: now,
              payload: {
                id: requestId,
                nodeId,
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "user_input",
                status: "pending",
                responseCapability: { type: "message" },
                createdAt: now,
                resolvedAt: null,
              },
            },
            {
              id: EventId.make(`${ending}-task:item`),
              type: "turn-item.updated",
              threadId: childThreadId,
              runId: childRun.id,
              nodeId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`item:${ending}-task`),
                type: "user_input_request",
                threadId: childThreadId,
                runId: childRun.id,
                nodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "waiting",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                requestId,
                questions: [
                  { id: "color", header: "Color", question: "Which color?", options: [] },
                ],
              },
            },
          ],
        });
        yield* Effect.forEach(stored, service.handleStoredEvent, { discard: true });
        const wakeId = MessageId.make(`question-escalation:${childThreadId}:${requestId}`);
        const wakeRun = () =>
          projections
            .getThreadRecords(parentThreadId, ["runs"])
            .pipe(Effect.map(({ runs }) => runs.find((run) => run.userMessageId === wakeId)));
        assert.equal((yield* wakeRun())?.status, "queued");

        // The child's turn ends with its question still open.
        yield* sink.write({
          events: [
            {
              id: EventId.make(`${ending}-task:child-completed`),
              type: "run.updated",
              threadId: childThreadId,
              runId: childRun.id,
              occurredAt: now,
              payload: { ...childRun, status: ending, startedAt: now, completedAt: now },
            },
          ],
        });
        yield* engine.recoverDelegatedTasks;
        const settled = (yield* projections.getThreadRecords(parentThreadId, ["subagents"], {
          subagentIds: [task.id],
        })).subagents[0];
        assert.equal(settled?.status, ending);
        assert.equal(
          (yield* projections.getRuntimeRequest(childThreadId, requestId))?.status,
          "pending",
        );

        yield* projections.apply({
          id: EventId.make(`${ending}-task:parent-completed`),
          type: "run.updated",
          threadId: parentThreadId,
          runId: parentRun.id,
          occurredAt: now,
          payload: { ...parentRun, status: "completed", completedAt: now },
        });
        yield* engine.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`resume:${ending}-task-parent`),
          threadId: parentThreadId,
        });
        assert.equal((yield* wakeRun())?.status, "starting");

        yield* engine.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(`answer:${ending}-task`),
          threadId: childThreadId,
          requestId,
          answers: { color: "Blue" },
        });
        const continued = (yield* projections.getThreadRecords(childThreadId, ["runs"])).runs.find(
          (run) => run.userMessageId === MessageId.make(`async-answer:${requestId}`),
        );
        assert.isDefined(continued);
        assert.notEqual(continued?.status, "cancelled");
      }).pipe(Effect.provide(QuestionEscalationService.layer), Effect.scoped),
  );
});
