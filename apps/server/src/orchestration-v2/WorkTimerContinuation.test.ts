import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import {
  driver,
  layerPlatformTest,
  layerServerConfig,
  modelSelection,
  layerCheckpointStoreTest,
  layerGitWorkflowTest,
  layerProjectServiceTest,
  layerTestProviderInstanceRegistry,
} from "./runtimeLayer.testkit.ts";

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);
it.layer(layerTest)("working timer continuations", (it) => {
  it.effect.each([
    { origin: "agent" as const, delivery: "queued" as const },
    { origin: "agent" as const, delivery: "after-completion" as const },
    { origin: "agent" as const, delivery: "held-resume" as const },
    { origin: "agent" as const, delivery: "resume-before-stop-ends" as const },
    { origin: "child" as const, delivery: "after-completion" as const },
    { origin: "user" as const, delivery: "queued" as const },
  ])(
    "preserves queued agent and child updates but resets fresh requests (%j)",
    ({ origin, delivery }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`work-clock-${origin}-${delivery}`);
        const originalMessageId = MessageId.make(`${threadId}-original`);
        const followUpMessageId = MessageId.make(`${threadId}-follow-up`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}-create`),
          threadId,
          projectId: ProjectId.make(`${threadId}-project`),
          title: "Agent message work clock",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}-original`),
          threadId,
          messageId: originalMessageId,
          text: "Original user work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const dispatchFollowUp = orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: origin === "user" ? "user" : "agent",
          creationSource: origin === "user" ? "web" : "mcp",
          ...(origin === "user" ? {} : { senderThreadId: ThreadId.make("sending-agent") }),
          commandId: CommandId.make(`${threadId}-follow-up`),
          threadId,
          messageId: followUpMessageId,
          text: "Follow-up work",
          attachments: [],
          modelSelection,
          dispatchMode: {
            type: delivery === "after-completion" ? "start_immediately" : "queue_after_active",
          },
        });
        const held = delivery === "held-resume" || delivery === "resume-before-stop-ends";
        const drainsOnEnd = delivery === "queued" || delivery === "resume-before-stop-ends";
        if (delivery === "queued" || held) yield* dispatchFollowUp;
        const startedRunIds = yield* Queue.unbounded<RunId>();
        const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
        yield* eventSink.stream({ threadId, afterSequence }).pipe(
          Stream.runForEach((stored) =>
            stored.event.type === "run.updated" && stored.event.payload.status === "starting"
              ? Queue.offer(startedRunIds, stored.event.payload.id)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        const original = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === originalMessageId,
        );
        assert.isDefined(original);
        if (origin === "child") {
          assert.isNotNull(original.rootNodeId);
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${threadId}-child`),
                type: "subagent.updated",
                threadId,
                runId: original.id,
                occurredAt: original.requestedAt,
                payload: {
                  id: NodeId.make(`${threadId}-child`),
                  threadId,
                  runId: original.id,
                  parentNodeId: original.rootNodeId,
                  origin: "app_owned",
                  createdBy: "agent",
                  driver,
                  providerInstanceId: original.providerInstanceId,
                  providerThreadId: null,
                  childThreadId: ThreadId.make("sending-agent"),
                  nativeTaskRef: null,
                  prompt: "Delegated work",
                  title: null,
                  model: null,
                  status: "completed",
                  result: "Done",
                  startedAt: original.requestedAt,
                  completedAt: original.requestedAt,
                  updatedAt: original.requestedAt,
                },
              },
            ],
          });
        }
        if (held) {
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.userMessageId === followUpMessageId,
          );
          assert.isDefined(queued);
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${threadId}-hold`),
                type: "run.updated",
                threadId,
                occurredAt: original.requestedAt,
                payload: { ...queued, queueHeld: true },
              },
              {
                id: EventId.make(`${threadId}-interrupt-request`),
                type: "turn-item.updated",
                threadId,
                runId: original.id,
                occurredAt: original.requestedAt,
                payload: {
                  id: TurnItemId.make(`${threadId}-interrupt-request`),
                  type: "run_interrupt_request",
                  threadId,
                  runId: original.id,
                  nodeId: original.rootNodeId,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 90,
                  status: "completed",
                  title: "Interrupt requested",
                  startedAt: original.requestedAt,
                  completedAt: original.requestedAt,
                  updatedAt: original.requestedAt,
                  message: "Stopped by user",
                },
              },
            ],
          });
        }
        if (delivery === "resume-before-stop-ends") {
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`${threadId}-resume`),
            threadId,
          });
        }
        const originalStart = DateTime.makeUnsafe("2026-10-21T14:20:17.457Z");
        const completedAt = DateTime.makeUnsafe("2026-10-21T14:23:53.509Z");
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}-completed`),
              type: "run.updated",
              threadId,
              runId: original.id,
              ...(original.rootNodeId === null ? {} : { nodeId: original.rootNodeId }),
              providerInstanceId: original.providerInstanceId,
              occurredAt: completedAt,
              payload: {
                ...original,
                status: held ? "interrupted" : "completed",
                startedAt: originalStart,
                completedAt,
              },
            },
          ],
        });
        if (delivery === "held-resume") {
          yield* TestClock.adjust("3 hours");
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.userMessageId === followUpMessageId,
          );
          assert.isDefined(queued);
          assert.equal(queued.status, "queued");
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`${threadId}-resume`),
            threadId,
          });
        } else if (delivery === "after-completion") yield* dispatchFollowUp;
        const startedRunId = drainsOnEnd ? yield* Queue.take(startedRunIds) : null;
        const followUp = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === followUpMessageId,
        );
        assert.isDefined(followUp);
        if (drainsOnEnd) assert.equal(startedRunId, followUp.id);
        assert.equal(followUp.status, "starting");
        if (origin === "child" || (origin === "agent" && delivery === "queued")) {
          assert.isDefined(followUp.workStartedAt);
          assert.equal(
            DateTime.toEpochMillis(followUp.workStartedAt),
            DateTime.toEpochMillis(originalStart),
          );
        } else {
          assert.isUndefined(followUp.workStartedAt);
        }
      }),
  );
});
