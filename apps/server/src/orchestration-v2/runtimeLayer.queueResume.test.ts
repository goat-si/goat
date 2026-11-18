import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
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

const queueResumeDisabledInstanceProjectId = ProjectId.make(
  "project:queue-resume-disabled-instance",
);

const layerQueueResumeDisabledInstanceTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(
    ServerSettings.layerTest({
      providerInstances: {
        [alternateInstanceId]: { driver: "codex", enabled: true },
      },
      projectSettingsOverrides: {
        [queueResumeDisabledInstanceProjectId]: {
          providerInstances: { [alternateInstanceId]: { enabled: false } },
        },
      },
    }),
  ),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

it.layer(layerQueueResumeDisabledInstanceTest)(
  "queue.resume on a project-disabled instance",
  (it) => {
    it.effect(
      "holds a queued run instead of starting it on an instance the project turned off",
      () =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const events = yield* EventSink.EventSinkV2;
          const threadId = ThreadId.make("queue-resume-disabled-instance-thread");
          const queuedModelSelection = {
            instanceId: alternateInstanceId,
            model: "gpt-5.5",
          } satisfies ModelSelection;

          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:create`),
            threadId,
            projectId: queueResumeDisabledInstanceProjectId,
            title: "Queue resume disabled instance",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:message:active`),
            threadId,
            messageId: MessageId.make(`${threadId}:message:active`),
            text: "Active",
            attachments: [],
            dispatchMode: { type: "defer_start" },
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:message:queued`),
            threadId,
            messageId: MessageId.make(`${threadId}:message:queued`),
            text: "Queued",
            attachments: [],
            modelSelection: queuedModelSelection,
            dispatchMode: { type: "queue_after_active" },
          });

          const before = yield* orchestrator.getThreadProjection(threadId);
          const activeRun = before.runs.find((run) => run.status !== "queued")!;
          const queuedRun = before.runs.find((run) => run.status === "queued")!;
          const now = yield* DateTime.now;
          yield* events.write({
            events: [
              {
                id: EventId.make(`${threadId}:active-completed`),
                type: "run.updated",
                threadId,
                runId: activeRun.id,
                occurredAt: now,
                payload: { ...activeRun, status: "completed", completedAt: now },
              },
            ],
          });

          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`${threadId}:resume`),
            threadId,
          });

          const resumed = yield* orchestrator.getThreadProjection(threadId);
          const resumedQueuedRun = resumed.runs.find((run) => run.id === queuedRun.id);
          assert.equal(
            resumedQueuedRun?.status,
            "queued",
            "a disabled instance must not start the queued run",
          );
          assert.isTrue(
            resumedQueuedRun?.queueHeld,
            "a refused resume re-holds the queue instead of leaving it looking resumable",
          );
        }),
    );
  },
);
