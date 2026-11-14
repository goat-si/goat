import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ProjectId, ThreadId, TurnItemId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
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
  layerPlatformTest,
  layerServerConfig,
  modelSelection,
  alternateInstanceId,
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
it.layer(layerTest)("limited provider queue", (it) => {
  it.effect.each(["the reset passes", "the user resumes"] as const)(
    "holds a limited provider's queue through another provider's turn until %s",
    (release) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`runtime-layer-queue-limit-switch-${release}`);
        const switchedSelection = { instanceId: alternateInstanceId, model: "gpt-5.5" };
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          createdBy: "user",
          creationSource: "web",
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Limit switch",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        const send = (
          name: string,
          selection: typeof modelSelection | typeof switchedSelection,
          type: "start_immediately" | "queue_after_active",
        ) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${threadId}:${name}`),
            threadId,
            messageId: MessageId.make(`${threadId}:${name}`),
            text: name,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            modelSelection: selection,
            dispatchMode: { type },
          });
        yield* send("limited", modelSelection, "start_immediately");
        yield* send("queued", modelSelection, "queue_after_active");
        const [limited, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs;
        assert.isDefined(limited);
        assert.isDefined(queued);
        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:error`),
              type: "turn-item.updated",
              threadId,
              runId: limited.id,
              nodeId: limited.rootNodeId!,
              providerInstanceId: limited.providerInstanceId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`${threadId}:error`),
                type: "error",
                threadId,
                runId: limited.id,
                nodeId: limited.rootNodeId!,
                providerThreadId: limited.providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 2,
                status: "failed",
                title: "Usage limit",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                failure: {
                  class: "usage_limit",
                  message: "Usage limit reached",
                  code: "usage_limit",
                  retryable: null,
                  resetAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
                },
              },
            },
            {
              id: EventId.make(`${threadId}:failed`),
              type: "run.updated",
              threadId,
              runId: limited.id,
              providerInstanceId: limited.providerInstanceId,
              occurredAt: now,
              payload: { ...limited, status: "failed", completedAt: now },
            },
          ],
        });

        // A message on another provider starts ahead of the held queue and
        // completes there.
        yield* send("switch", switchedSelection, "start_immediately");
        const switched = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === MessageId.make(`${threadId}:switch`),
        );
        assert.equal(switched?.status, "starting");
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:switch:completed`),
              type: "run.updated",
              threadId,
              runId: switched!.id,
              providerInstanceId: switched!.providerInstanceId,
              occurredAt: now,
              payload: { ...switched!, status: "completed", completedAt: now },
            },
          ],
        });

        yield* orchestrator.resumeQueuedRuns;
        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(held.runs.find((run) => run.id === queued.id)?.status, "queued");

        if (release === "the reset passes") {
          yield* TestClock.adjust("61 minutes");
          yield* orchestrator.resumeQueuedRuns;
        } else {
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`${threadId}:resume`),
            threadId,
          });
        }
        const reset = yield* orchestrator.getThreadProjection(threadId);
        const resumed = reset.runs.find((run) => run.id === queued.id);
        assert.equal(resumed?.status, "starting");
        assert.deepEqual(resumed?.modelSelection, modelSelection);
      }),
  );
});
